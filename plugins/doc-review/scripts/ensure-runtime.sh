#!/bin/sh
# doc-review: ensure-runtime.sh
#
# Makes doc-review runnable on this machine, once, and prints ONE line of JSON saying where:
#
#   {"mdr":"<abs path of the mdr command>","node":"26.5.0","app":"<app version>","firstRun":false}
#
# What it does (idempotent: a second run only checks and prints):
#   1. Node.js: if ${DATA}/node/bin/node is not the pinned version, downloads the OFFICIAL Node.js tarball for this
#      OS and CPU from nodejs.org, checks its SHA-256 against scripts/runtime.lock (a mismatch installs nothing),
#      and unpacks only bin/node and the license.
#   2. The app: copies runtime/mdr.mjs and runtime/web into ${DATA}/app/<app version>/.
#   3. A wrapper: writes ${DATA}/bin/mdr, a two-line shell script that runs that Node on that app.
# It never edits PATH or any shell profile, never uses sudo, and writes only under ${DATA}.
#
# Usage:  sh ensure-runtime.sh [--check] [DATA_DIR] [-- mdr-command...]
#   DATA_DIR   the plugin's data folder (${CLAUDE_PLUGIN_DATA}). Falls back to $CLAUDE_PLUGIN_DATA, then to
#              ~/.claude/plugins/data/doc-review-doc-review.
#   --check    never downloads. Prints the JSON line and exits 0 when everything is ready. A plugin update leaves the data
#              folder with an older app copy and wrapper (the old wrapper still runs): --check refreshes those from the
#              plugin's own files, which is local and instant, and then reports ready. Only a missing or wrong Node.js, the one
#              thing that needs the network, prints {"ready":false} and exits 10 (nothing is installed then).
#
# Exit codes: 0 ready | 2 unsupported system or missing tool | 3 download failed | 4 checksum mismatch
#             5 install failed | 6 data folder not writable | 7 the network blocked nodejs.org | 10 --check and not ready
# With `-- <mdr command>` after the options, a ready setup then runs that command and exits with its code; its JSON is
# the second stdout line.
#
# Needs only sh, curl (or wget), tar, a SHA-256 tool (shasum, sha256sum or openssl), cmp and standard coreutils. No
# python3, no git. On Windows (Git Bash) it hands over to ensure-runtime.ps1.
#
# Test/mirror hook: DOC_REVIEW_NODE_BASE_URL replaces the download folder from runtime.lock. The pinned
# SHA-256 is still enforced, so a mirror cannot change what gets installed.
set -eu

say() { printf '%s\n' "$*" >&2; }
die() {
  code=$1
  shift
  say "doc-review setup failed: $*"
  exit "$code"
}

# ---- where this script lives ---------------------------------------------------------------------------------------
# On Windows (Git Bash / MSYS / Cygwin) Claude Code may hand us the script as C:\Users\... or C:/Users/...: turn that
# into the shell's own /c/Users/... form BEFORE anything takes dirname of it (a backslash path has no "/" in it, so
# dirname would answer "." and the plugin would look for its files in the current folder).
OS=$(uname -s 2>/dev/null || echo unknown)
IS_WIN=0
case $OS in MINGW* | MSYS* | CYGWIN*) IS_WIN=1 ;; esac
to_posix() {
  case $1 in
    [A-Za-z]:\\* | [A-Za-z]:/* | \\\\*)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -u "$1"
      else
        _d=$(printf '%s' "$1" | cut -c1 | tr 'A-Z' 'a-z')
        printf '/%s%s' "$_d" "$(printf '%s' "$1" | cut -c3- | tr '\\' '/')"
      fi
      ;;
    *) printf '%s' "$1" ;;
  esac
}
SELF=$0
[ "$IS_WIN" = 0 ] || SELF=$(to_posix "$SELF")
case $SELF in /*) ;; *) SELF=$PWD/$SELF ;; esac
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$SELF")" && pwd -P) || die 5 "cannot find the plugin folder from $0"
PLUGIN_DIR=$(dirname -- "$SCRIPT_DIR")
LOCK=$SCRIPT_DIR/runtime.lock

# ---- arguments ----------------------------------------------------------------------------------------------------
# Everything after `--` is an mdr command run once setup is ready (one Bash call, one approval: setup + open):
#   sh ensure-runtime.sh "<data>" -- open "/abs/plan.md" --offer-tour
CHECK=0
DATA=
while [ $# -gt 0 ]; do
  case $1 in
    --) shift; break ;;
    --check) CHECK=1 ;;
    -*) die 2 "unknown option $1 (usage: sh ensure-runtime.sh [--check] [DATA_DIR] [-- mdr-command...])" ;;
    *) DATA=$1 ;;
  esac
  shift
done
# "$@" is now the mdr command to run after setup (may be empty)

# run "$@" with the installed mdr once setup printed its JSON line (the mdr's own JSON goes on the next line)
then_mdr() { # $1 = the mdr command path; the rest = its arguments
  _m=$1
  shift
  [ $# -gt 0 ] || return 0
  "$_m" "$@"
}

# ---- Windows (Git Bash / MSYS / Cygwin): delegate to PowerShell -----------------------------------------------------
if [ "$IS_WIN" = 1 ]; then
  command -v powershell.exe >/dev/null 2>&1 || die 2 "PowerShell was not found on this Windows machine"
  ps1=$SCRIPT_DIR/ensure-runtime.ps1
  case $DATA in *'$'* | *'{'*) DATA= ;; esac
  [ -n "$DATA" ] || DATA=${CLAUDE_PLUGIN_DATA:-}
  case $DATA in *'$'* | *'{'*) DATA= ;; esac
  if command -v cygpath >/dev/null 2>&1; then
    ps1=$(cygpath -w "$ps1")
    [ -z "$DATA" ] || DATA=$(cygpath -w "$DATA")
  fi
  c=
  [ "$CHECK" = 0 ] || c=-Check
  # -Posix: also write bin/mdr, a sh launcher that runs node.exe directly (no cmd.exe re-parsing of % ^ & "), and print
  # it as "mdr" with forward slashes, the form Git Bash runs and quotes safely
  if [ -n "$DATA" ]; then
    out=$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ps1" -Posix $c -DataDir "$DATA") || { rc=$?; [ -z "${out:-}" ] || printf '%s\n' "$out"; exit $rc; }
  else
    out=$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ps1" -Posix $c) || { rc=$?; [ -z "${out:-}" ] || printf '%s\n' "$out"; exit $rc; }
  fi
  out=$(printf '%s\n' "$out" | tr -d '\r' | grep '^{' | tail -n 1)
  printf '%s\n' "$out"
  mdr=$(printf '%s' "$out" | sed -n 's/.*"mdr":"\([^"]*\)".*/\1/p' | sed 's/\\\\/\\/g; s/\\\//\//g')
  [ -n "$mdr" ] || die 5 "setup finished but did not say where mdr is"
  then_mdr "$mdr" "$@"
  exit $?
fi

# ---- the data folder ----------------------------------------------------------------------------------------------
# An unsubstituted ${CLAUDE_PLUGIN_DATA} (the host failed to fill it in) must not become a folder named "${...}".
case $DATA in '' | *'$'* | *'{'*) DATA=${CLAUDE_PLUGIN_DATA:-} ;; esac
case $DATA in '' | *'$'* | *'{'*) DATA=${HOME:-}/.claude/plugins/data/doc-review-doc-review ;; esac
case $DATA in /*) ;; *) die 6 "the data folder must be an absolute path (got: $DATA)" ;; esac
mkdir -p "$DATA" 2>/dev/null || die 6 "cannot create $DATA"
[ -w "$DATA" ] || die 6 "cannot write to $DATA"
DATA=$(CDPATH='' cd -- "$DATA" && pwd -P)

# ---- the lock file ------------------------------------------------------------------------------------------------
[ -f "$LOCK" ] || die 5 "scripts/runtime.lock is missing from the plugin"
lock_get() { sed -n "s/^$1=//p" "$LOCK" | tr -d '\r' | head -n 1; }
NODE_VERSION=$(lock_get NODE_VERSION)
BASE_URL=$(lock_get NODE_BASE_URL)
[ -n "$NODE_VERSION" ] && [ -n "$BASE_URL" ] || die 5 "scripts/runtime.lock is incomplete"
OVERRIDE=0
if [ -n "${DOC_REVIEW_NODE_BASE_URL:-}" ]; then
  BASE_URL=$DOC_REVIEW_NODE_BASE_URL
  OVERRIDE=1
fi

# ---- the plugin's own files ---------------------------------------------------------------------------------------
SRC=$PLUGIN_DIR/runtime
[ -f "$SRC/mdr.mjs" ] && [ -f "$SRC/web/index.html" ] || die 5 "the plugin's runtime/ folder is incomplete (mdr.mjs or web/ is missing); reinstall the plugin"

hash_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 | sed 's/^.*= *//'
  else
    return 1
  fi
}
sha256_of() { hash_stdin <"$1"; }
command -v tar >/dev/null 2>&1 || die 2 "tar was not found"
command -v cmp >/dev/null 2>&1 || die 2 "cmp was not found"
{ command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1; } ||
  die 2 "no SHA-256 tool was found (looked for shasum, sha256sum and openssl)"

PLUGIN_VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null | head -n 1)
[ -n "$PLUGIN_VERSION" ] || PLUGIN_VERSION=0
# the app version names the exact bits: index.html names the SPA's hashed asset files, so it changes when the SPA does
SRC_SHA=$(cat "$SRC/mdr.mjs" "$SRC/web/index.html" | hash_stdin) || die 2 "could not hash the app files"
APP_VER=$PLUGIN_VERSION-$(printf '%s' "$SRC_SHA" | cut -c1-12)

NODE_BIN=$DATA/node/bin/node
APP_DIR=$DATA/app/$APP_VER
WRAPPER=$DATA/bin/mdr

# ---- quoting / JSON helpers ---------------------------------------------------------------------------------------
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
# the command text the CLI prints in its hints: the bare path when it is plain, else single-quoted
cmd_text() {
  case $1 in
    *[!A-Za-z0-9_./:+@%=,-]*) shq "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

emit_ready() { # $1 = firstRun (true|false)
  printf '{"mdr":%s,"node":%s,"app":%s,"firstRun":%s}\n' "$(json_str "$WRAPPER")" "$(json_str "$NODE_VERSION")" "$(json_str "$APP_VER")" "$1"
}

node_ok() {
  [ -x "$NODE_BIN" ] && [ "$(cat "$DATA/node/VERSION" 2>/dev/null || true)" = "$NODE_VERSION" ] &&
    [ "$("$NODE_BIN" --version 2>/dev/null || true)" = "v$NODE_VERSION" ]
}
app_ok() { [ -f "$APP_DIR/.complete" ] && [ -f "$APP_DIR/mdr.mjs" ] && [ -f "$APP_DIR/web/index.html" ]; }
wrapper_ok() { [ -x "$WRAPPER" ] && grep -qF "/app/$APP_VER/mdr.mjs" "$WRAPPER" 2>/dev/null; }
all_ok() { node_ok && app_ok && wrapper_ok; }

# ---- fast path ----------------------------------------------------------------------------------------------------
if all_ok; then
  emit_ready false
  then_mdr "$WRAPPER" "$@"
  exit $?
fi
# --check stops here only when Node.js would have to be downloaded; a stale app copy or wrapper falls through and is
# refreshed below (step 1 is skipped when Node is fine)
if [ "$CHECK" = 1 ] && ! node_ok; then
  printf '{"ready":false}\n'
  exit 10
fi

# ---- a failed download: blocked by the network, or just offline? -------------------------------------------------------
BLOCKED_MSG="your company network blocked the download; ask IT to allow nodejs.org (the official Node.js website), then ask me again. Nothing was installed."
PROBE_URL=${DOC_REVIEW_PROBE_URL:-https://api.anthropic.com}
# Claude itself is talking to the internet, so when nodejs.org fails while the probe answers, something in between
# (a firewall, a proxy, SSL inspection) is refusing nodejs.org.
probe_ok() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -sS -o /dev/null --connect-timeout 10 --max-time 15 "$PROBE_URL" >/dev/null 2>&1
}
download_failed() { # $1 = curl/wget exit code, $2 = HTTP status (curl only)
  case ${2:-} in 401 | 403 | 407 | 451 | 511) die 7 "$BLOCKED_MSG" ;; esac
  case $1 in
    # TLS failures: a proxy re-signing HTTPS with a company certificate (SSL inspection)
    35 | 51 | 53 | 58 | 59 | 60 | 77 | 80 | 83 | 90 | 91) die 7 "$BLOCKED_MSG" ;;
    # 5 proxy name, 6 host name, 7 connect, 28 timeout, 56 connection reset, 52 empty reply; wget 4 network, 5 TLS, 8 HTTP error
    5 | 6 | 7 | 28 | 52 | 56 | 4 | 8) if probe_ok; then die 7 "$BLOCKED_MSG"; fi ;;
  esac
  die 3 "could not download $URL (check the internet connection, a VPN or proxy)"
}

# ---- platform -----------------------------------------------------------------------------------------------------
case $(uname -s) in
  Darwin) PLAT=darwin ;;
  Linux) PLAT=linux ;;
  *) die 2 "unsupported operating system $(uname -s) (doc-review supports macOS, Linux and, in beta, Windows)" ;;
esac
case $(uname -m) in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) die 2 "unsupported CPU $(uname -m)" ;;
esac
# a terminal running under Rosetta reports x86_64 on an Apple Silicon Mac: use the native build
if [ "$PLAT" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi

# ---- one installer at a time --------------------------------------------------------------------------------------
LOCKDIR=$DATA/.install.lock
TMP=
HAVE_LOCK=0
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  [ "$HAVE_LOCK" = 0 ] || rmdir "$LOCKDIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

waited=0
while ! mkdir "$LOCKDIR" 2>/dev/null; do
  # a lock older than 15 minutes belongs to an installer that died
  if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +15 2>/dev/null || true)" ]; then
    rmdir "$LOCKDIR" 2>/dev/null || true
    continue
  fi
  if [ "$waited" -ge 180 ]; then die 5 "another doc-review setup has been running for over 3 minutes ($LOCKDIR)"; fi
  if [ "$waited" = 0 ]; then say "Another doc-review setup is already running; waiting for it to finish..."; fi
  sleep 1
  waited=$((waited + 1))
  if all_ok; then
    emit_ready false
    then_mdr "$WRAPPER" "$@"
    exit $?
  fi
done
HAVE_LOCK=1
mkdir -p "$DATA/bin" "$DATA/app"
TMP=$DATA/.tmp-$$
rm -rf "$TMP"
mkdir -p "$TMP"
FIRST_RUN=false

# ---- step 1: Node.js ----------------------------------------------------------------------------------------------
if ! node_ok; then
  FIRST_RUN=true
  FILE=node-v$NODE_VERSION-$PLAT-$ARCH.tar.gz
  KEY=$(printf 'NODE_SHA256_%s_%s' "$PLAT" "$ARCH" | tr 'a-z' 'A-Z')
  WANT=$(lock_get "$KEY")
  [ -n "$WANT" ] || die 2 "scripts/runtime.lock has no checksum for $PLAT-$ARCH ($KEY)"
  URL=$BASE_URL/$FILE
  say "Setting up doc-review (one time): downloading Node.js $NODE_VERSION for $PLAT-$ARCH from $URL (about 55 MB)..."
  rc=0
  HTTP=
  if command -v curl >/dev/null 2>&1; then
    if [ "$OVERRIDE" = 1 ]; then
      HTTP=$(curl -fsSL -w '%{http_code}' --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "$TMP/$FILE" "$URL") || rc=$?
    else
      HTTP=$(curl -fsSL -w '%{http_code}' --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "$TMP/$FILE" "$URL") || rc=$?
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=30 -O "$TMP/$FILE" "$URL" || rc=$?
  else
    die 2 "neither curl nor wget was found"
  fi
  [ "$rc" = 0 ] || download_failed "$rc" "$HTTP"
  GOT=$(sha256_of "$TMP/$FILE") || die 2 "could not hash the download"
  if [ "$GOT" != "$WANT" ]; then
    # a proxy that blocks a site often answers with its own small web page instead of the file
    SIZE=$(wc -c <"$TMP/$FILE" | tr -d ' ')
    HEAD=$(head -c 64 "$TMP/$FILE" 2>/dev/null | tr -d '\000' | tr 'A-Z' 'a-z')
    rm -f "$TMP/$FILE"
    case $HEAD in *'<'*html* | *'<!doctype'* | *'<?xml'*) die 7 "$BLOCKED_MSG" ;; esac
    [ "$OVERRIDE" = 1 ] || [ "${SIZE:-0}" -ge 1000000 ] || die 7 "$BLOCKED_MSG"
    die 4 "the downloaded Node.js does not match the checksum pinned in runtime.lock (expected $WANT, got $GOT). Nothing was installed."
  fi
  say "Checksum verified. Unpacking..."
  TOP=node-v$NODE_VERSION-$PLAT-$ARCH
  tar -xzf "$TMP/$FILE" -C "$TMP" "$TOP/bin/node" || die 5 "could not unpack Node.js from the download"
  tar -xzf "$TMP/$FILE" -C "$TMP" "$TOP/LICENSE" 2>/dev/null || true
  rm -f "$TMP/$FILE"
  chmod 755 "$TMP/$TOP/bin/node"
  [ "$("$TMP/$TOP/bin/node" --version 2>/dev/null || true)" = "v$NODE_VERSION" ] ||
    die 5 "the unpacked Node.js does not run on this machine (expected v$NODE_VERSION). On Alpine Linux and other musl systems the official Node.js build does not run."
  rm -rf "$DATA/node.old"
  [ ! -d "$DATA/node" ] || mv "$DATA/node" "$DATA/node.old"
  mkdir -p "$DATA/node/bin"
  mv "$TMP/$TOP/bin/node" "$DATA/node/bin/node"
  [ ! -f "$TMP/$TOP/LICENSE" ] || mv "$TMP/$TOP/LICENSE" "$DATA/node/LICENSE"
  printf '%s\n' "$NODE_VERSION" >"$DATA/node/VERSION"
  rm -rf "$DATA/node.old"
  node_ok || die 5 "Node.js was installed but does not run from $NODE_BIN"
fi

# ---- step 2: the app ----------------------------------------------------------------------------------------------
if ! app_ok; then
  STAGE=$TMP/app
  mkdir -p "$STAGE"
  cp "$SRC/mdr.mjs" "$STAGE/mdr.mjs"
  cp -R "$SRC/web" "$STAGE/web"
  for extra in BUILD.txt THIRD_PARTY_LICENSES.txt; do [ ! -f "$SRC/$extra" ] || cp "$SRC/$extra" "$STAGE/$extra"; done
  cmp -s "$SRC/mdr.mjs" "$STAGE/mdr.mjs" || die 5 "the copy of mdr.mjs does not match the original (disk full?)"
  : >"$STAGE/.complete"
  rm -rf "$APP_DIR"
  mv "$STAGE" "$APP_DIR"
fi

# ---- step 3: the wrapper ------------------------------------------------------------------------------------------
if ! wrapper_ok; then
  W=$TMP/mdr
  {
    printf '#!/bin/sh\n'
    printf '# Generated by the doc-review plugin (ensure-runtime.sh). Safe to delete: the skill recreates it.\n'
    printf '[ -n "${MDR_CMD:-}" ] || MDR_CMD=%s\n' "$(shq "$(cmd_text "$WRAPPER")")"
    printf 'export MDR_CMD\n'
    printf 'exec %s %s "$@"\n' "$(shq "$NODE_BIN")" "$(shq "$APP_DIR/mdr.mjs")"
  } >"$W"
  chmod 755 "$W"
  mv "$W" "$WRAPPER"
fi

# ---- tidy: keep this app version and the one before it (a running review may still point at it) ---------------------
# shellcheck disable=SC2012
for old in $(ls -1t "$DATA/app" 2>/dev/null | sed -n '3,$p'); do
  case $old in .* | "$APP_VER") ;; *) rm -rf "${DATA:?}/app/$old" ;; esac
done

all_ok || die 5 "setup finished but the result does not verify (see $DATA)"
emit_ready "$FIRST_RUN"
trap - EXIT
cleanup
then_mdr "$WRAPPER" "$@"
