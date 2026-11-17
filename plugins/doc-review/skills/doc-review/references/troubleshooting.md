# Troubleshooting

Every `mdr` failure is one `CliErr` JSON line (`error.code`, `error.message`, often `error.hint`) and an exit code.
Read the code, not the prose. The full code-by-code table is at the end of `cli.md`.

## Setup (`ensure-runtime.sh`) failed

Setup is the first thing the skill runs; its exit codes are its own and have nothing to do with the `mdr` table below.
It prints one plain sentence on stderr: pass it on in one line, in the user's words, and add the matching advice. Never
install Node.js another way, never use `sudo`, never edit `PATH` or a shell profile, and never edit `runtime.lock`
to get past a mismatch.

| Exit | What happened | Tell the user |
|---|---|---|
| 2 | Unsupported system, or `curl`/`tar` or a SHA-256 tool is missing | "doc-review can't be set up on this computer: <the sentence>. It supports macOS and Linux; Windows is in beta." |
| 3 | The download from nodejs.org failed | "I couldn't download the helper program from nodejs.org. Check the internet connection or VPN; if your company blocks nodejs.org, ask IT to allow it." Retry once. |
| 4 | The download did not match the fingerprint pinned in the plugin | "The download didn't match its fingerprint, so I threw it away and installed nothing. A proxy that rewrites downloads can cause this. Please tell IT or the plugin owner." Retry once at most; never bypass. |
| 5 | Install or verification failed, or the plugin's own files are incomplete | Pass on the sentence. "does not run on this machine" (for example Alpine Linux) means unsupported. "runtime/ folder is incomplete" means reinstall the plugin. Otherwise retry once. |
| 6 | The plugin's data folder is not writable | "I can't write to <folder>. Check its permissions or free up disk space." |
| 7 | The network refused nodejs.org (HTTP 403/407, SSL inspection, a block page, or nodejs.org unreachable while the internet works) | "Your company network blocked the download. Ask IT to allow nodejs.org, then ask me again." Nothing was installed. Don't retry, don't look for another way. |
| 10 | Only with `--check`: not set up yet | Not an error: this is the first-run path in SKILL.md. |

**Windows (beta).** In Git Bash (Claude Code's usual shell on Windows) the same `sh` command works: it hands over to
PowerShell and prints `mdr` as a forward-slash path (`C:/Users/ana/.claude/plugins/data/…/bin/mdr`), a small sh
launcher; quote it and run it like any path. If `sh` is not found (a PowerShell-only session), run
`powershell -NoProfile -ExecutionPolicy Bypass -File "<plugin>/scripts/ensure-runtime.ps1" -DataDir "<data>"` (add
`-Check` for the check form): it prints `...\bin\mdr.cmd`. In PowerShell there are no `<<'JSON'` heredocs and no
`/tmp`: write batch JSON to a file and use `--ops-file`, `--body-file`, `--md-file`, `--replace-file`. If `waiter` comes
back `null`, no POSIX shell was found: Send to Claude copies a prompt to paste instead.

If the install looks half-finished or corrupt, and only with the user's OK: `mdr stop --all`, delete the `node` and
`app` folders inside the plugin's data folder (two levels above the `mdr` path setup printed: `<data>/bin/mdr`), and run
setup again. Review notes live next to each document, not in the data folder, so nothing of the user's is lost.

## By exit code

| Exit | What it means | What to do |
|---|---|---|
| 1 | `INTERNAL`: a bug or an unexpected server answer | Report it in one line with the message; run `mdr status`. |
| 2 | `wait` timed out while connected | Nothing: the waiter loop re-runs it silently. You never see it. |
| 3 | `BAD_REQUEST`, `USAGE`, `IDENTITY_IN_BODY`, `PAYLOAD_TOO_LARGE`, `ACK_OUT_OF_RANGE` | Fix the command or the JSON (the message names the field) and retry. |
| 4 | `UNAUTHORIZED`, `FORBIDDEN_ORIGIN`, `PROTECTED_ROOT`, `PATH_OUTSIDE_ROOT`, `NOT_AUTHOR`, `SUGGEST_ONLY`, `READ_ONLY`, `UNANCHORABLE_TARGET` | A refusal: change the request (a narrower root, a `suggest` instead of an edit, a block comment instead of a quote). Never work around it. |
| 5 | not found: file, thread, comment, suggestion, version, block, quote | Re-read with `mdr snapshot --md` or `mdr pending`; for `QUOTE_NOT_IN_SOURCE` retry with `error.sourceQuote`. |
| 6 | `QUOTE_AMBIGUOUS` | Retry with `--occurrence N` from `error.candidates`, or `--near bN --base-rev R`. |
| 7 | `STALE_REVISION`, `CONFLICT`, suggestion state, `BLOCK_MERGE_HAZARD`, `BATCH_SELF_CONFLICT`, `ACK_CONFLICT` | The doc or the log moved under you: use `current` / `remap`, or `mdr pending` again, and retry. |
| 8 | `SERVER_START_FAILED`, `ROOT_MISMATCH`, `PORT_EXHAUSTED`, `PROTOCOL_MISMATCH`, `MISDIRECTED` | Do not retry without a fix (below). The waiter loop exits on 8 and wakes you once. |
| 9 | `LOCK_TIMEOUT`, `SIDECAR_CORRUPT`, `SIDECAR_SCHEMA_UNSUPPORTED`, `NOT_UTF8`, `TOO_LARGE`, `SUGGESTION_RESIDUE`, `SPLICE_MISMATCH`, `CONTRACT_MISMATCH`, `IO_ERROR` | Storage or read-only trouble: report it in one line. `LOCK_TIMEOUT` may be retried once. `mdr doctor` diagnoses. |
| 10 | `WAITER_SUPERSEDED`, `SERVER_STOPPED`, `DISARMED` | Nothing is waiting on you. Say so; start a loop only if the review is open and `mdr arm` shows `attached: false`. |
| 11 | `SERVER_UNREACHABLE`: `wait` saw no server until its deadline | Nothing: the waiter loop sleeps 5 s and re-runs it by itself until the server is back. |
| 130 | `INTERRUPTED` | The process was stopped; nothing to do. |

## Specific situations

**`PROTOCOL_MISMATCH` (exit 8).** The running server is older or newer than this CLI. Tell the user to run
`mdr serve "<root>" --restart` (it stops only the same-root server, then starts a current one). The waiter loop exits
on it and wakes you once; `mdr arm` fails the same way, so start no new loop until `mdr arm` succeeds. Send to
Claude falls back to the clipboard meanwhile.

**`PORT_EXHAUSTED` (exit 8).** All ten ports in this root's window (`mdr port "<root>"` shows the formula port) are
held by other roots' servers or other programs. mdr never stops or takes over a port it doesn't own. Tell the user which
window is full; `mdr stop "<other root>"` frees one of their own servers if they want that.

**`ROOT_MISMATCH` (exit 8).** Something answered on the port that doesn't serve this root. Report it; don't retry.

**`PROTECTED_ROOT` (exit 4).** The root is `/`, `$HOME`, inside a folder the user marked protected, or holds one
anywhere below it (`MDR_PROTECTED_SEGMENTS`, or `protectedSegments` in `mdr config get`; none by default). Serve the
narrower folder that holds the doc. A refusal is the guard working; never move files to get around it. One case is
the user's own call: a document that sits directly in their home folder has `$HOME` as its root. Tell them doc-review
won't open it there, and ask whether they want to put it in a folder of its own and give you the new path.

**Clipboard-primary mode (`waiter: null`).** `waiterReason` says why: this build makes Send to Claude copy a prompt
instead of waking a waiter, or (Windows) no POSIX shell was found for the loop line; Git for Windows provides one.
Start no loop; tell the user "Send to Claude gives you a prompt to paste here." When they paste it, run `mdr pending`
and carry on as after a wake.

**`mdr status --wait-waiter 5` doesn't show `connected`.** The loop didn't attach (it may have exited at once; its
output says why). Tell the user Send to Claude gives them a prompt to paste, and end the turn.

**The page won't load ("can't connect") or shows a stale doc.** The server stops itself after 4 hours with no open tab,
waiter or request, or the computer restarted. Run `mdr open "<abs>"` again: it starts a fresh one on the same port and
the review log is untouched. Tell the user the URL again.

**The Browser pane asks whether Claude may open `127.0.0.1`.** That is the review page, served by this computer only.
The user says yes (once is enough for the session). If it is declined, give them the URL to open in any browser.

**Exit 11 from the loop.** You won't see it: the loop retries 11 itself. If the server is down for good, the loop keeps
waiting quietly and Send falls back to the clipboard; a deliberate `mdr stop` ends the loop with exit 10 instead.

**Read-only states.** `mdr status` reports `readOnly` (`NOT_UTF8`, `TOO_LARGE`, `SIDECAR_CORRUPT`,
`SIDECAR_SCHEMA_UNSUPPORTED`, `DOC_GONE`): the user can still read every thread, but writes fail. Report it; for a corrupt
log, `mdr doctor "<abs>"` shows the bad line and `--repair` quarantines it, only on the user's say-so.

**`LOCK_TIMEOUT` (exit 9).** Another writer held the doc lock for over 5 s. Retry once; report it if it persists.

**`needsRecovery: true` in `mdr status`.** A write was interrupted. The next write (or the server opening the doc)
recovers it automatically; nothing for you to do.
