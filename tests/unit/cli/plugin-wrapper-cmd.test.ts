// tests/unit/cli/plugin-wrapper-cmd.test.ts (final pass 2026-11-16). The Windows mdr.cmd wrapper that
// ensure-runtime.ps1 writes. Static: there is no PowerShell on the test hosts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../helpers/tmpRoot'

const PS1 = join(REPO_ROOT, 'plugins', 'doc-review', 'scripts', 'ensure-runtime.ps1')

describe('the Windows mdr.cmd wrapper', () => {
  const ps1 = readFileSync(PS1, 'utf8')
  const body = ps1.slice(ps1.indexOf('step 3: the wrapper'), ps1.indexOf('tidy: keep this app version'))

  it("doubles % in every path it writes into the .cmd, so a user folder with a % can't expand as a variable", () => {
    for (const v of ['Wrapper', 'NodeExe', 'AppDir']) {
      expect(body).toMatch(new RegExp(`\\$\\w+ = \\$${v} -replace '%', '%%'`))
    }
    // the two batch lines use only the escaped copies
    // (the sh launcher's own lines, built with ShQ, are checked below)
    const lines = body.split(/\r?\n/).filter((l) => (l.includes('MDR_CMD=') || l.includes('mdr.mjs')) && !l.includes('ShQ'))
    expect(lines.length).toBe(2)
    for (const l of lines) expect(l).not.toMatch(/\$(Wrapper|NodeExe|AppDir)\b/)
  })

  it('-Posix also writes bin/mdr: a sh launcher (LF, UTF-8 without BOM) that execs node.exe directly with forward-slash, single-quoted paths', () => {
    expect(ps1).toMatch(/\[switch\]\$Posix/)
    expect(body).toMatch(/if \(\$Posix\) \{/)
    expect(body).toContain("'#!/bin/sh'")
    expect(body).toContain('-join "`n"')
    expect(body).toContain('New-Object System.Text.UTF8Encoding($false)')
    expect(body).toMatch(/'exec ' \+ \(ShQ \(Fwd \$NodeExe\)\)/)
    expect(body).toContain('\'/mdr.mjs\')) + \' "$@"\'')
    // and that is what it reports as "mdr" (the .cmd stays as mdrCmd)
    expect(ps1).toMatch(/mdr = \(Fwd \$Shim\); mdrCmd = \$Wrapper/)
  })

  it('ShQ single-quotes for sh the way the .sh twin does (an apostrophe in a user name survives)', () => {
    expect(ps1).toContain(`function ShQ([string]$v) { return "'" + ($v -replace "'", "'\\''") + "'" }`)
    expect(ps1).toContain("function Fwd([string]$p) { return $p -replace '\\\\', '/' }")
  })

  it('Node goes in a folder named after its version, so a Node bump never deletes a node.exe a running server holds', () => {
    expect(ps1).toContain('$NodeDir = Join-Path $Data "node\\$NodeVersion"')
    expect(ps1).not.toMatch(/Remove-Item -LiteralPath \(Join-Path \$Data 'node'\) -Recurse/)
  })

  it('a blocked network says so in the same words as the .sh, exit 7; stdout is UTF-8 for Git Bash', () => {
    const sh = readFileSync(PS1.replace(/\.ps1$/, '.sh'), 'utf8')
    const msg = 'your company network blocked the download; ask IT to allow nodejs.org (the official Node.js website), then ask me again. Nothing was installed.'
    expect(ps1).toContain(`$BlockedMsg = '${msg}'`)
    expect(sh).toContain(`BLOCKED_MSG="${msg}"`)
    expect(ps1).toMatch(/Die 7 \$BlockedMsg/)
    expect(ps1).toContain('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)')
  })
})
