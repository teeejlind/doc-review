// web/src/editor/frontmatter/scan.ts (P2, pure). The YAML frontmatter line scanner (CONTRACTS §12.12 A).
//
// There is no YAML library (none is in the dependency list), and the panel never needs one: it shows top-level
// `key: value` lines and edits the simple ones in place, one line at a time, so every other byte of the YAML stays
// as written. scanFrontmatter reads the text between the fences:
// - a field line matches FIELD_RE at column 0; its value kind is plain, single ('…'), double ("…") or empty;
// - a field line followed by indented lines or `- ` items, or whose value starts with | > [ { & *, or whose quote
//   doesn't close on that line, is `multiline` (block scalars, lists, flow collections, nested maps, anchors) and is
//   shown read-only with "Edit YAML";
// - blank lines and full-line `#` comments are kept and never shown as fields;
// - any other line makes the scan `unrecognized` (the panel then offers only the raw editor).

/** §12.12: a field line, at column 0. Group 1 = key, group 2 = the value (trailing blanks excluded). */
export const FIELD_RE = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*):(?:[ \t]+(.*?))?[ \t]*$/
/** A key the panel may add (the field regex's key part). */
export const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/

export type FieldKind = 'plain' | 'single' | 'double' | 'empty' | 'multiline'

export interface FrontmatterField {
  key: string
  kind: FieldKind
  /** The value as shown: unquoted for single/double, verbatim for plain, '' for empty, the source lines for multiline. */
  value: string
  /** A trailing ` #…` comment outside quotes, with the blanks before it, exactly as written; null when none. */
  comment: string | null
  /** 0-based index of the field line; `endLine` is exclusive (multiline fields span several lines). */
  line: number
  endLine: number
  /** plain / single / double / empty, and the first occurrence of its key. */
  editable: boolean
  /** The key occurs more than once (the row shows a warning; only the first occurrence is editable). */
  duplicate: boolean
}

export interface FrontmatterScan {
  /** false = `unrecognized`: some line is none of field / continuation / blank / comment. */
  recognized: boolean
  fields: FrontmatterField[]
  /** The frontmatter's EOL (the first line break's; '\n' when there is none). */
  eol: '\n' | '\r\n'
  /** Lines without their EOL. */
  lines: string[]
  /** Index of the first line that made the scan unrecognized, or -1. */
  unrecognizedLine: number
}

export interface LineSpan { start: number; end: number; eolEnd: number }

/** Line spans over the raw text: [start, end) is the line without its EOL, eolEnd includes it. */
export function lineSpans(yaml: string): LineSpan[] {
  const out: LineSpan[] = []
  if (yaml === '') return out
  let i = 0
  while (i <= yaml.length) {
    const nl = yaml.indexOf('\n', i)
    if (nl < 0) {
      out.push({ start: i, end: yaml.length, eolEnd: yaml.length })
      break
    }
    const end = nl > i && yaml[nl - 1] === '\r' ? nl - 1 : nl
    out.push({ start: i, end, eolEnd: nl + 1 })
    i = nl + 1
    if (i === yaml.length) {
      out.push({ start: i, end: i, eolEnd: i })
      break
    }
  }
  return out
}

export function eolOf(yaml: string, fallback: '\n' | '\r\n' = '\n'): '\n' | '\r\n' {
  const nl = yaml.indexOf('\n')
  if (nl < 0) return fallback
  return nl > 0 && yaml[nl - 1] === '\r' ? '\r\n' : '\n'
}

/** Parsed value part of a field line: kind, shown value, trailing comment; null = not a one-line scalar. */
export interface ValueParse { kind: 'plain' | 'single' | 'double' | 'empty'; value: string; comment: string | null }

function commentAfter(rest: string): string | null | false {
  // after a closed quote: nothing, or blanks + `#…`; anything else is not a one-line scalar
  if (/^[ \t]*$/.test(rest)) return null
  if (/^[ \t]+#/.test(rest)) return rest
  return false
}

const DOUBLE_ESCAPES: Readonly<Record<string, string>> = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t', r: '\r', '0': '\0', ' ': ' ', b: '\b', f: '\f', e: '\x1b', a: '\x07', v: '\v', _: ' ', N: '', L: '', P: '' }

/**
 * Classify the text after `key:` (and its blanks). `raw` is everything after the colon, trailing blanks included,
 * so a trailing comment keeps its exact bytes.
 */
export function parseValue(raw: string): ValueParse | null {
  const v = raw.replace(/^[ \t]+/, '')
  if (/^[ \t]*$/.test(v)) return { kind: 'empty', value: '', comment: null }
  if (v.startsWith('#')) return { kind: 'empty', value: '', comment: raw.replace(/[ \t]+$/, '') }
  const c0 = v[0]!
  if ('|>[{&*'.includes(c0)) return null
  if (c0 === "'") {
    let i = 1
    let out = ''
    for (; i < v.length; i++) {
      if (v[i] === "'") {
        if (v[i + 1] === "'") {
          out += "'"
          i++
          continue
        }
        break
      }
      out += v[i]
    }
    if (i >= v.length) return null // the quote doesn't close on this line
    const c = commentAfter(v.slice(i + 1))
    if (c === false) return null
    return { kind: 'single', value: out, comment: c === null ? null : c.replace(/[ \t]+$/, '') }
  }
  if (c0 === '"') {
    let i = 1
    let out = ''
    for (; i < v.length; i++) {
      const ch = v[i]!
      if (ch === '\\') {
        const nx = v[i + 1]
        if (nx === undefined) return null
        if (nx === 'x' || nx === 'u' || nx === 'U') {
          const len = nx === 'x' ? 2 : nx === 'u' ? 4 : 8
          const hex = v.slice(i + 2, i + 2 + len)
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null
          out += String.fromCodePoint(parseInt(hex, 16))
          i += 1 + len
          continue
        }
        const e = DOUBLE_ESCAPES[nx]
        if (e === undefined) return null
        out += e
        i++
        continue
      }
      if (ch === '"') break
      out += ch
    }
    if (i >= v.length) return null
    const c = commentAfter(v.slice(i + 1))
    if (c === false) return null
    return { kind: 'double', value: out, comment: c === null ? null : c.replace(/[ \t]+$/, '') }
  }
  // plain: a ` #` (blank then #) starts a comment
  const m = /[ \t]#/.exec(v)
  if (m) {
    const value = v.slice(0, m.index).replace(/[ \t]+$/, '')
    const lead = v.slice(0, m.index).length - value.length
    return { kind: 'plain', value, comment: v.slice(m.index - lead).replace(/[ \t]+$/, '') }
  }
  return { kind: 'plain', value: v.replace(/[ \t]+$/, ''), comment: null }
}

const isBlank = (l: string): boolean => /^[ \t]*$/.test(l)
const isComment = (l: string): boolean => l.startsWith('#')
const isIndented = (l: string): boolean => /^[ \t]/.test(l) && !isBlank(l)
const isItem = (l: string): boolean => l === '-' || l.startsWith('- ')

export function scanFrontmatter(yaml: string): FrontmatterScan {
  const spans = lineSpans(yaml)
  const lines = spans.map((s) => yaml.slice(s.start, s.end))
  const fields: FrontmatterField[] = []
  let unrecognizedLine = -1
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line) || isComment(line)) {
      i++
      continue
    }
    const m = FIELD_RE.exec(line)
    if (!m) {
      if (unrecognizedLine < 0) unrecognizedLine = i
      i++
      continue
    }
    const key = m[1]!
    const colon = line.indexOf(':', key.length)
    const parsed = parseValue(line.slice(colon + 1))
    // continuation: indented lines and `- ` items, through blank lines that are followed by more continuation
    let end = i + 1
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (isIndented(l) || isItem(l)) {
        end = j + 1
        continue
      }
      if (isBlank(l)) continue
      break
    }
    const multiline = end > i + 1 || parsed === null
    fields.push({
      key,
      kind: multiline ? 'multiline' : parsed!.kind,
      value: multiline ? lines.slice(i, end).join('\n').slice(colon + 1).replace(/^[ \t]+/, '') : parsed!.value,
      comment: multiline ? null : parsed!.comment,
      line: i,
      endLine: end,
      editable: false,
      duplicate: false,
    })
    i = end
  }
  const seen = new Map<string, number>()
  for (const f of fields) seen.set(f.key, (seen.get(f.key) ?? 0) + 1)
  const first = new Set<string>()
  for (const f of fields) {
    f.duplicate = (seen.get(f.key) ?? 0) > 1
    f.editable = f.kind !== 'multiline' && !first.has(f.key)
    first.add(f.key)
  }
  return { recognized: unrecognizedLine < 0, fields, eol: eolOf(yaml), lines, unrecognizedLine }
}

/** The panel's status chip: the top-level key matching /^status$/i, as plain text (a multi-line value: its first line). */
export function frontmatterStatus(scan: FrontmatterScan): string | null {
  const f = scan.fields.find((x) => /^status$/i.test(x.key))
  if (!f) return null
  if (f.kind !== 'multiline') return f.value
  const lines = f.value.split('\n').map((l) => l.trim()).filter((l) => l && !/^[|>][+-]?\d*$/.test(l))
  return (lines[0] ?? '').replace(/^-\s+/, '')
}
