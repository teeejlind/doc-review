// tests/unit/web/editor/keys.ts (P2). Normalize prosemirror-keymap names so two spellings of one key compare equal
// (modifier order and Cmd/Ctrl/Meta all fold to Mod).
export function normalizeKey(k: string): string {
  const parts = k.split(/-(?!$)/)
  const key = parts.pop()!
  const mods = new Set(parts.map((p) => (/^(cmd|meta|ctrl|c|m|mod)$/i.test(p) ? 'Mod' : /^(alt|a|option)$/i.test(p) ? 'Alt' : /^(shift|s)$/i.test(p) ? 'Shift' : p)))
  const base = key.length === 1 ? key.toLowerCase() : key
  return `${mods.has('Mod') ? 'Mod-' : ''}${mods.has('Alt') ? 'Alt-' : ''}${mods.has('Shift') ? 'Shift-' : ''}${base}`
}
