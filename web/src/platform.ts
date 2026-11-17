// web/src/platform.ts (Pass 4 #21). The one place the page asks which platform it is on, and spells a shortcut for it.
// Every shortcut hint (toolbar titles, the top bar, the floating Comment button, the copy-failed dialog) goes through
// `shortcut`, so a Windows reader never sees a ⌘. Read per call, not at load: a test can emulate Windows by setting
// navigator.platform, and the answer can't go stale.

/** True on macOS and iOS, where chords are written with ⌘ ⌥ ⇧ glyphs. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

const GLYPHS: Record<string, [mac: string, other: string]> = {
  Mod: ['⌘', 'Ctrl'],
  Alt: ['⌥', 'Alt'],
  Shift: ['⇧', 'Shift'],
  Enter: ['↩', 'Enter'],
}

/** A chord as it reads here: shortcut('Mod', 'Alt', 'M') is "⌘⌥M" on a Mac and "Ctrl+Alt+M" elsewhere. */
export function shortcut(...keys: string[]): string {
  const mac = isMac()
  const parts = keys.map((k) => GLYPHS[k]?.[mac ? 0 : 1] ?? k)
  return parts.join(mac ? '' : '+')
}

/**
 * A key that AltGr turned into a character ('[' is AltGr+8 on German and AltGr+` on Spanish keyboards). Windows sends
 * AltGr as Ctrl+Alt, so '[' and ']' typed that way matched the Mod-Alt-[ / ] comment chords and never reached the
 * doc. Typing wins: a chord whose AltGr key makes a printable non-alphanumeric character is not a shortcut. Letter and
 * digit chords (the mode chords, Mod-Alt-m) keep working.
 */
export function isAltGrChar(e: Pick<KeyboardEvent, 'key'> & { getModifierState?: (k: string) => boolean }): boolean {
  return !!e.getModifierState?.('AltGraph') && e.key.length === 1 && !/[\p{L}\p{N}]/u.test(e.key)
}
