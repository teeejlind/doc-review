// tests/unit/node/identity-os-full-name.test.ts (final pass 2026-11-16): the OS full-name step of the display name has
// a Windows branch (it was macOS-only, so a Windows teammate with no git name showed as their login, e.g. "adiaz").
import { describe, expect, it } from 'vitest'
import { osFullName, WINDOWS_FULL_NAME_SCRIPT, type RunCommand } from '../../../node/identity'

function recorder(out: string | Error): { run: RunCommand; calls: Array<{ cmd: string; args: readonly string[]; timeoutMs: number }> } {
  const calls: Array<{ cmd: string; args: readonly string[]; timeoutMs: number }> = []
  return {
    calls,
    run: (cmd, args, timeoutMs) => {
      calls.push({ cmd, args, timeoutMs })
      if (out instanceof Error) throw out
      return out
    },
  }
}

describe('osFullName', () => {
  it("Windows asks PowerShell for the account's display name, UTF-8, bounded, and cleans it", () => {
    const r = recorder('Ana Díaz\r\n')
    expect(osFullName('win32', r.run)).toBe('Ana Díaz')
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.cmd).toBe('powershell.exe')
    expect(r.calls[0]!.args).toContain('-NoProfile')
    expect(r.calls[0]!.args.at(-1)).toBe(WINDOWS_FULL_NAME_SCRIPT)
    expect(WINDOWS_FULL_NAME_SCRIPT).toContain('UserPrincipal]::Current.DisplayName')
    expect(WINDOWS_FULL_NAME_SCRIPT).toContain('OutputEncoding = [Text.Encoding]::UTF8')
    expect(r.calls[0]!.timeoutMs).toBeLessThanOrEqual(3000)
  })
  it('Windows: an empty answer, a timeout or a missing PowerShell falls through (null)', () => {
    expect(osFullName('win32', recorder('\r\n').run)).toBeNull()
    expect(osFullName('win32', recorder(Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' })).run)).toBeNull()
    expect(osFullName('win32', recorder(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })).run)).toBeNull()
  })
  it('macOS keeps `id -F`; Linux has no lookup', () => {
    const mac = recorder('TJ Lind\n')
    expect(osFullName('darwin', mac.run)).toBe('TJ Lind')
    expect(mac.calls[0]).toMatchObject({ cmd: 'id', args: ['-F'] })
    const linux = recorder('x')
    expect(osFullName('linux', linux.run)).toBeNull()
    expect(linux.calls).toHaveLength(0)
  })
})
