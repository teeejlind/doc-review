# doc-review: ensure-runtime.ps1   (Windows; BETA, not yet tested on a real Windows machine)
#
# The same job as ensure-runtime.sh, for Windows PowerShell 5.1+ / PowerShell 7:
#   1. downloads the OFFICIAL Node.js zip from nodejs.org and checks its SHA-256 against scripts\runtime.lock
#      (a mismatch installs nothing), then unpacks only node.exe and the license
#   2. copies runtime\mdr.mjs and runtime\web into <data>\app\<app version>\
#   3. writes <data>\bin\mdr.cmd, and with -Posix also <data>\bin\mdr: a sh launcher that runs node.exe directly, so Git
#      Bash (Claude Code's shell on Windows) never sends arguments through cmd.exe, which re-parses % ^ & and quotes
# and prints ONE line of JSON on stdout:
#   {"mdr":"<abs path of mdr.cmd>","node":"26.5.0","app":"<app version>","firstRun":false}
# With -Posix (how ensure-runtime.sh calls it from Git Bash) "mdr" is the sh launcher as C:/Users/... (forward slashes:
# backslashes are eaten when Claude re-quotes a path in bash) and "mdrCmd" is the .cmd.
# It never edits PATH or any profile and writes only under <data>.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File ensure-runtime.ps1 [-Check] [-Posix] [-DataDir <folder>]
#   -Check   never downloads. A plugin update leaves an older app copy and wrapper behind (the old wrapper still runs):
#            -Check refreshes those from the plugin's own files, which is local and instant, and then reports ready.
#            Only a missing or wrong Node.js prints {"ready":false} and exits 10 (nothing is installed then).
# Exit codes: 0 ready | 2 unsupported system | 3 download failed | 4 checksum mismatch | 5 install failed
#             6 data folder not writable | 7 the network blocked nodejs.org | 10 -Check and Node.js is not installed

param(
  [string]$DataDir = '',
  [switch]$Check,
  [switch]$Posix
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# stdout goes to Git Bash, which reads UTF-8: a user folder with an accented letter must not arrive in the OEM code page
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say([string]$m) { [Console]::Error.WriteLine($m) }
function Die([int]$code, [string]$m) { Say "doc-review setup failed: $m"; exit $code }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginDir = Split-Path -Parent $ScriptDir
$LockFile = Join-Path $ScriptDir 'runtime.lock'

# ---- the data folder --------------------------------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($DataDir) -or $DataDir.Contains('$') -or $DataDir.Contains('{')) { $DataDir = $env:CLAUDE_PLUGIN_DATA }
if ([string]::IsNullOrWhiteSpace($DataDir) -or $DataDir.Contains('$') -or $DataDir.Contains('{')) {
  $DataDir = Join-Path $env:USERPROFILE '.claude\plugins\data\doc-review-doc-review'
}
if (-not [System.IO.Path]::IsPathRooted($DataDir)) { Die 6 "the data folder must be an absolute path (got: $DataDir)" }
try {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $Data = (Resolve-Path -LiteralPath $DataDir).Path
  $probe = Join-Path $Data ".write-test-$PID"
  Set-Content -LiteralPath $probe -Value 'x'
  Remove-Item -LiteralPath $probe -Force
} catch { Die 6 "cannot write to $DataDir ($($_.Exception.Message))" }

# ---- the lock file ----------------------------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $LockFile)) { Die 5 'scripts\runtime.lock is missing from the plugin' }
$Lock = @{}
foreach ($line in Get-Content -LiteralPath $LockFile) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $k, $v = $line.Split('=', 2)
  $Lock[$k.Trim()] = $v.Trim()
}
$NodeVersion = $Lock['NODE_VERSION']
$BaseUrl = $Lock['NODE_BASE_URL']
if (-not $NodeVersion -or -not $BaseUrl) { Die 5 'scripts\runtime.lock is incomplete' }
if ($env:DOC_REVIEW_NODE_BASE_URL) { $BaseUrl = $env:DOC_REVIEW_NODE_BASE_URL }

# ---- the plugin's own files -------------------------------------------------------------------------------------------
$Src = Join-Path $PluginDir 'runtime'
$SrcMdr = Join-Path $Src 'mdr.mjs'
$SrcIndex = Join-Path $Src 'web\index.html'
if (-not (Test-Path -LiteralPath $SrcMdr) -or -not (Test-Path -LiteralPath $SrcIndex)) {
  Die 5 "the plugin's runtime folder is incomplete (mdr.mjs or web\ is missing); reinstall the plugin"
}
$PluginVersion = '0'
try { $PluginVersion = (Get-Content -Raw -LiteralPath (Join-Path $PluginDir '.claude-plugin\plugin.json') | ConvertFrom-Json).version } catch { }

# the app version names the exact bits: index.html names the SPA's hashed asset files, so it changes when the SPA does
# (a MemoryStream, never `array + array`: PowerShell would box 6.5 million bytes one by one)
$ms = New-Object System.IO.MemoryStream
foreach ($f in $SrcMdr, $SrcIndex) { $b = [System.IO.File]::ReadAllBytes($f); $ms.Write($b, 0, $b.Length) }
$ms.Position = 0
$sha = [System.Security.Cryptography.SHA256]::Create()
$AppVer = "$PluginVersion-" + (([System.BitConverter]::ToString($sha.ComputeHash($ms)) -replace '-', '').ToLower().Substring(0, 12))
$ms.Dispose()

# Node lives in a folder named after its version: a Node bump installs beside the old one, which Windows may hold
# locked while an older mdr server still runs from it, instead of deleting it first
$NodeDir = Join-Path $Data "node\$NodeVersion"
$NodeExe = Join-Path $NodeDir 'node.exe'
$AppDir = Join-Path $Data "app\$AppVer"
$Wrapper = Join-Path $Data 'bin\mdr.cmd'
$Shim = Join-Path $Data 'bin\mdr'
function Fwd([string]$p) { return $p -replace '\\', '/' }
function ShQ([string]$v) { return "'" + ($v -replace "'", "'\''") + "'" }

function Test-NodeOk {
  if (-not (Test-Path -LiteralPath $NodeExe)) { return $false }
  $vf = Join-Path $NodeDir 'VERSION'
  if (-not (Test-Path -LiteralPath $vf)) { return $false }
  if ((Get-Content -LiteralPath $vf -Raw).Trim() -ne $NodeVersion) { return $false }
  try { return ((& $NodeExe --version 2>$null) -eq "v$NodeVersion") } catch { return $false }
}
function Test-AppOk {
  return (Test-Path -LiteralPath (Join-Path $AppDir '.complete')) -and (Test-Path -LiteralPath (Join-Path $AppDir 'mdr.mjs')) -and (Test-Path -LiteralPath (Join-Path $AppDir 'web\index.html'))
}
function Test-WrapperOk {
  if (-not (Test-Path -LiteralPath $Wrapper)) { return $false }
  $w = Get-Content -LiteralPath $Wrapper -Raw
  if (-not $w.Contains("app\$AppVer\mdr.mjs") -or -not $w.Contains(($NodeExe -replace '%', '%%'))) { return $false }
  if ($Posix) {
    if (-not (Test-Path -LiteralPath $Shim)) { return $false }
    $t = Get-Content -LiteralPath $Shim -Raw
    if (-not $t.Contains((Fwd $AppDir) + '/mdr.mjs') -or -not $t.Contains((Fwd $NodeExe))) { return $false }
  }
  return $true
}
function Write-Ready([bool]$firstRun) {
  if ($Posix) { $o = [ordered]@{ mdr = (Fwd $Shim); mdrCmd = $Wrapper; node = $NodeVersion; app = $AppVer; firstRun = $firstRun } }
  else { $o = [ordered]@{ mdr = $Wrapper; node = $NodeVersion; app = $AppVer; firstRun = $firstRun } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
}

# ---- fast path --------------------------------------------------------------------------------------------------------
if ((Test-NodeOk) -and (Test-AppOk) -and (Test-WrapperOk)) { Write-Ready $false; exit 0 }
# -Check stops here only when Node.js would have to be downloaded; a stale app copy or wrapper falls through and is
# refreshed below (step 1 is skipped when Node is fine)
if ($Check -and -not (Test-NodeOk)) { [Console]::Out.WriteLine('{"ready":false}'); exit 10 }

# ---- a failed download: blocked by the network, or just offline? -------------------------------------------------------
$BlockedMsg = 'your company network blocked the download; ask IT to allow nodejs.org (the official Node.js website), then ask me again. Nothing was installed.'
$ProbeUrl = if ($env:DOC_REVIEW_PROBE_URL) { $env:DOC_REVIEW_PROBE_URL } else { 'https://api.anthropic.com' }
# Claude itself is talking to the internet: when nodejs.org fails while this answers (any HTTP status), something in
# between (a firewall, a proxy) is refusing nodejs.org
function Test-ProbeOk {
  try { Invoke-WebRequest -UseBasicParsing -Uri $ProbeUrl -Method Head -TimeoutSec 15 | Out-Null; return $true }
  catch { try { return [bool]$_.Exception.Response } catch { return $false } }
}

# ---- platform ---------------------------------------------------------------------------------------------------------
$archRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($archRaw) {
  'AMD64' { $Arch = 'x64' }
  'ARM64' { $Arch = 'arm64' }
  default { Die 2 "unsupported CPU $archRaw" }
}

# ---- one installer at a time ------------------------------------------------------------------------------------------
$LockDir = Join-Path $Data '.install.lock'
$haveLock = $false
$waited = 0
while (-not $haveLock) {
  try { New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null; $haveLock = $true }
  catch {
    if ((Test-Path -LiteralPath $LockDir) -and ((Get-Item -LiteralPath $LockDir).LastWriteTime -lt (Get-Date).AddMinutes(-15))) {
      Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue
      continue
    }
    if ($waited -ge 180) { Die 5 "another doc-review setup has been running for over 3 minutes ($LockDir)" }
    if ($waited -eq 0) { Say 'Another doc-review setup is already running; waiting for it to finish...' }
    Start-Sleep -Seconds 1
    $waited++
    if ((Test-NodeOk) -and (Test-AppOk) -and (Test-WrapperOk)) { Write-Ready $false; exit 0 }
  }
}
$Tmp = Join-Path $Data ".tmp-$PID"
try {
  if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Tmp, (Join-Path $Data 'bin'), (Join-Path $Data 'app') | Out-Null
  $firstRun = $false

  # ---- step 1: Node.js ------------------------------------------------------------------------------------------------
  if (-not (Test-NodeOk)) {
    $firstRun = $true
    $File = "node-v$NodeVersion-win-$Arch.zip"
    $Want = $Lock[('NODE_SHA256_WIN_' + $Arch.ToUpper())]
    if (-not $Want) { Die 2 "scripts\runtime.lock has no checksum for win-$Arch" }
    $Url = "$BaseUrl/$File"
    Say "Setting up doc-review (one time): downloading Node.js $NodeVersion for win-$Arch from $Url (about 40 MB)..."
    $Zip = Join-Path $Tmp $File
    try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Zip }
    catch {
      $err = $_.Exception
      $status = 0
      try { if ($err.Response) { $status = [int]$err.Response.StatusCode } } catch { }
      if (@(401, 403, 407, 451, 511) -contains $status) { Die 7 $BlockedMsg }
      # TLS refused (SSL inspection with a company certificate), or nodejs.org unreachable while the internet works
      if ("$($err.Message) $($err.InnerException)" -match 'SSL|TLS|trust relationship|secure channel|certificate') { Die 7 $BlockedMsg }
      if ($status -eq 0 -and (Test-ProbeOk)) { Die 7 $BlockedMsg }
      Die 3 "could not download $Url ($($err.Message)). Check the internet connection, a VPN or proxy."
    }
    $Got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLower()
    if ($Got -ne $Want.ToLower()) {
      # a proxy that blocks a site often answers with its own small web page instead of the file
      $size = (Get-Item -LiteralPath $Zip).Length
      $head = ''
      try { $fs = [System.IO.File]::OpenRead($Zip); $buf = New-Object byte[] 64; $n = $fs.Read($buf, 0, 64); $fs.Dispose(); $head = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n).ToLower() } catch { }
      Remove-Item -LiteralPath $Zip -Force
      if ($head -match '<html|<!doctype|<\?xml' -or (-not $env:DOC_REVIEW_NODE_BASE_URL -and $size -lt 1000000)) { Die 7 $BlockedMsg }
      Die 4 "the downloaded Node.js does not match the checksum pinned in runtime.lock (expected $Want, got $Got). Nothing was installed."
    }
    Say 'Checksum verified. Unpacking...'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $top = "node-v$NodeVersion-win-$Arch"
    $stageNode = Join-Path $Tmp 'node'
    New-Item -ItemType Directory -Force -Path $stageNode | Out-Null
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
    try {
      foreach ($entry in $archive.Entries) {
        if ($entry.FullName -eq "$top/node.exe") { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $stageNode 'node.exe'), $true) }
        elseif ($entry.FullName -eq "$top/LICENSE") { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $stageNode 'LICENSE'), $true) }
      }
    } finally { $archive.Dispose() }
    Remove-Item -LiteralPath $Zip -Force
    if (-not (Test-Path -LiteralPath (Join-Path $stageNode 'node.exe'))) { Die 5 'could not unpack node.exe from the download' }
    $ver = & (Join-Path $stageNode 'node.exe') --version 2>$null
    if ($ver -ne "v$NodeVersion") { Die 5 "the unpacked Node.js does not run on this machine (expected v$NodeVersion)" }
    Set-Content -LiteralPath (Join-Path $stageNode 'VERSION') -Value $NodeVersion
    New-Item -ItemType Directory -Force -Path (Join-Path $Data 'node') | Out-Null
    if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
    Move-Item -LiteralPath $stageNode -Destination $NodeDir
    # older layouts and versions: best effort (a node.exe still running is locked; it goes next time)
    foreach ($old in (Join-Path $Data 'node\node.exe'), (Join-Path $Data 'node\VERSION'), (Join-Path $Data 'node\LICENSE')) {
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    }
    Get-ChildItem -LiteralPath (Join-Path $Data 'node') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $NodeVersion } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not (Test-NodeOk)) { Die 5 "Node.js was installed but does not run from $NodeExe" }
  }

  # ---- step 2: the app ------------------------------------------------------------------------------------------------
  if (-not (Test-AppOk)) {
    $stage = Join-Path $Tmp 'app'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item -LiteralPath $SrcMdr -Destination (Join-Path $stage 'mdr.mjs')
    Copy-Item -LiteralPath (Join-Path $Src 'web') -Destination (Join-Path $stage 'web') -Recurse
    foreach ($extra in 'BUILD.txt', 'THIRD_PARTY_LICENSES.txt') {
      $p = Join-Path $Src $extra
      if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $stage $extra) }
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $SrcMdr).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage 'mdr.mjs')).Hash) {
      Die 5 'the copy of mdr.mjs does not match the original (disk full?)'
    }
    Set-Content -LiteralPath (Join-Path $stage '.complete') -Value ''
    if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
    Move-Item -LiteralPath $stage -Destination $AppDir
  }

  # ---- step 3: the wrapper --------------------------------------------------------------------------------------------
  if (-not (Test-WrapperOk)) {
    # inside a .cmd file %...% expands as a variable even within quotes: a path with a % (a user folder named "50%")
    # must have it doubled. & ^ | < > are literal inside the quotes, and delayed expansion (!) is off by default.
    $wq = $Wrapper -replace '%', '%%'
    $nq = $NodeExe -replace '%', '%%'
    $aq = $AppDir -replace '%', '%%'
    $cmd = @(
      '@echo off',
      'rem Generated by the doc-review plugin (ensure-runtime.ps1). Safe to delete: the skill recreates it.',
      "if not defined MDR_CMD set `"MDR_CMD=$wq`"",
      "`"$nq`" `"$aq\mdr.mjs`" %*",
      'exit /b %ERRORLEVEL%'
    ) -join "`r`n"
    $tmpWrapper = Join-Path $Tmp 'mdr.cmd'
    # cmd.exe reads a .cmd file in the OEM code page; fall back to ASCII where that encoding is unavailable
    try { $enc = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) } catch { $enc = New-Object System.Text.ASCIIEncoding }
    [System.IO.File]::WriteAllText($tmpWrapper, $cmd + "`r`n", $enc)
    Move-Item -LiteralPath $tmpWrapper -Destination $Wrapper -Force
    if ($Posix) {
      # the sh launcher Git Bash runs: LF endings, UTF-8 without a BOM, every path single-quoted for sh
      $sh = @(
        '#!/bin/sh',
        '# Generated by the doc-review plugin (ensure-runtime.ps1 -Posix). Safe to delete: the skill recreates it.',
        ('[ -n "${MDR_CMD:-}" ] || MDR_CMD=' + (ShQ (Fwd $Shim))),
        'export MDR_CMD',
        ('exec ' + (ShQ (Fwd $NodeExe)) + ' ' + (ShQ ((Fwd $AppDir) + '/mdr.mjs')) + ' "$@"')
      ) -join "`n"
      $tmpShim = Join-Path $Tmp 'mdr'
      [System.IO.File]::WriteAllText($tmpShim, $sh + "`n", (New-Object System.Text.UTF8Encoding($false)))
      Move-Item -LiteralPath $tmpShim -Destination $Shim -Force
    }
  }

  # ---- tidy: keep this app version and the one before it --------------------------------------------------------------
  Get-ChildItem -LiteralPath (Join-Path $Data 'app') -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 |
    Where-Object { $_.Name -ne $AppVer } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  if (-not ((Test-NodeOk) -and (Test-AppOk) -and (Test-WrapperOk))) { Die 5 "setup finished but the result does not verify (see $Data)" }
  Write-Ready $firstRun
} finally {
  if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
  if ($haveLock) { Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue }
}
