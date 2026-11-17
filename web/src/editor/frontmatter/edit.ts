// web/src/editor/frontmatter/edit.ts (P2, pure). Quote-preserving one-line edits to the YAML frontmatter
// (CONTRACTS §12.12 A "Field editing").
//
// Each function returns the new text between the fences. Exactly one line changes (edit), is inserted (add) or is
// deleted (remove); every other byte, EOLs and comments included, is copied from the input. The editor commits the
// result as one attr change on the frontmatter atom, so only that block re-serializes (S2: frontmatter field edits
// touch only that YAML line, 9/9).
import { eolOf, FIELD_RE, KEY_RE, lineSpans, parseValue, scanFrontmatter, type FrontmatterField } from './scan'

export class FrontmatterEditError extends Error {
  constructor(readonly code: 'NO_SUCH_KEY' | 'NOT_EDITABLE' | 'BAD_KEY' | 'KEY_EXISTS' | 'UNRECOGNIZED', message: string) {
    super(message)
    this.name = 'FrontmatterEditError'
  }
}

const BOOLISH = /^(?:true|false|null|~|yes|no)$/i
const NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|0x[0-9a-fA-F_]+|0o[0-7_]+|\.inf|\.nan)$/i

/** A value YAML would read as something other than a string (bool, null, number). */
export function isTypedScalar(v: string): boolean {
  return BOOLISH.test(v) || NUMBER.test(v)
}

/**
 * §12.12 quoting rule for a plain (or empty) field's new value: true when it can't stay a plain scalar. `old` is the
 * field's previous plain value ('' for an empty field): a typed scalar replacing a typed scalar stays plain.
 */
export function needsQuoting(v: string, old: string): boolean {
  if (v === '') return true
  if (/^[ \t]|[ \t]$/.test(v)) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return true
  if (v.includes(': ') || v.includes(' #') || v.endsWith(':') || v.includes('\t')) return true
  if (isTypedScalar(v) && !isTypedScalar(old)) return true
  return false
}

export function quoteSingle(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

export function quoteDouble(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The value part a field of `kind` re-emits for `v` (quote style preserved; plain/empty quote only when needed). */
export function emitValue(kind: FrontmatterField['kind'], v: string, old: string): string {
  if (kind === 'single') return quoteSingle(v)
  if (kind === 'double') return quoteDouble(v)
  return needsQuoting(v, kind === 'empty' ? '' : old) ? quoteDouble(v) : v
}

const oneLine = (v: string): string => v.replace(/\r\n|\r|\n/g, ' ')

function fieldFor(yaml: string, key: string): { f: FrontmatterField; start: number; end: number; eolEnd: number } {
  const scan = scanFrontmatter(yaml)
  const f = scan.fields.find((x) => x.key === key)
  if (!f) throw new FrontmatterEditError('NO_SUCH_KEY', `no field "${key}"`)
  if (!f.editable) throw new FrontmatterEditError('NOT_EDITABLE', `field "${key}" is ${f.kind === 'multiline' ? 'multi-line' : 'a duplicate'}; use Edit YAML`)
  const span = lineSpans(yaml)[f.line]!
  return { f, ...span }
}

/** Replace the value of `key` (its first occurrence), keeping its quote style, spacing and trailing comment. */
export function editFrontmatterField(yaml: string, key: string, newValue: string): string {
  const { f, start, end } = fieldFor(yaml, key)
  const line = yaml.slice(start, end)
  const colon = line.indexOf(':', key.length)
  const after = line.slice(colon + 1)
  const sep = /^[ \t]*/.exec(after)![0] || ' '
  const parsed = parseValue(after)
  const v = oneLine(newValue)
  if (f.kind === 'empty' && v === '') return yaml // still empty: nothing to write
  const value = emitValue(f.kind, v, parsed?.kind === 'plain' ? parsed.value : '')
  const comment = f.comment ? (/^[ \t]/.test(f.comment) ? f.comment : ` ${f.comment}`) : ''
  return yaml.slice(0, start) + line.slice(0, colon + 1) + sep + value + comment + yaml.slice(end)
}

/** Insert `key: value` just before the closing fence, in the frontmatter's EOL (`eol` when the YAML has none). */
export function addFrontmatterField(yaml: string, key: string, value: string, o: { eol?: '\n' | '\r\n' } = {}): string {
  if (!KEY_RE.test(key) || /[ \t]$/.test(key)) throw new FrontmatterEditError('BAD_KEY', `"${key}" is not a valid key`)
  const scan = scanFrontmatter(yaml)
  if (scan.fields.some((f) => f.key === key)) throw new FrontmatterEditError('KEY_EXISTS', `"${key}" already exists`)
  const v = oneLine(value)
  const line = `${key}:${v === '' ? '' : ` ${emitValue('empty', v, '')}`}`
  if (!FIELD_RE.test(line)) throw new FrontmatterEditError('BAD_KEY', `"${key}" is not a valid key`)
  if (yaml === '') return line
  const eol = eolOf(yaml, o.eol ?? '\n')
  // a YAML that already ends with a line break gets the line after it, so no blank line appears
  if (yaml.endsWith('\n')) return yaml + line
  return yaml + eol + line
}

/** Delete the line of `key` (a plain / single / double / empty field). */
export function removeFrontmatterField(yaml: string, key: string): string {
  const { start, eolEnd, end } = fieldFor(yaml, key)
  if (eolEnd > end) return yaml.slice(0, start) + yaml.slice(eolEnd)
  // the last line: take the line break before it instead
  let s = start
  if (s > 0 && yaml[s - 1] === '\n') s--
  if (s > 0 && yaml[s - 1] === '\r') s--
  return yaml.slice(0, s) + yaml.slice(end)
}
