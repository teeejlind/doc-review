// tests/contract/tokens.test.ts (integrator, day 0; CONTRACTS §12.2.1, §12.2.2, §1.3).
//
// The theme-token boundary, enforced in both directions:
// - every `--mdr-*` name used or defined anywhere under web/ is in THEME_TOKENS (shared/types.ts);
// - P2's CSS (web/src/{editor,session}/**/*.css) has no colour literal (hex, rgb/hsl/..., named colour), no literal
//   font family and no literal radius, and never selects outside #mdr-editor-host / #mdr-toolbar-host;
// - P3's tokens.css defines every THEME_TOKENS name for light (:root), for dark under prefers-color-scheme and under
//   :root[data-theme="dark"], with data-theme="light" forcing light;
// - no CSS under web/ other than tokens.css (P2's or P3's) uses a colour literal, and P3's CSS never selects inside
//   the editor or toolbar hosts.
// The checker itself is unit-tested on synthetic CSS below, so the suite has teeth before P2 and P3 write any CSS.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '../../shared/types'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const WEB = join(REPO, 'web')
const TOKENS_CSS = join(WEB, 'src/theme/tokens.css')
const TOKEN_SET: ReadonlySet<string> = new Set(THEME_TOKENS)

// =====================================================================================
// A small CSS reader: comments stripped, nested blocks and at-rules tracked, declarations with line numbers.
// =====================================================================================

export interface CssDecl {
  prop: string
  value: string
  line: number
}
export interface CssRule {
  /** Selector chain for nested rules, outermost first. Empty for declarations directly inside an at-rule. */
  selectors: string[]
  /** Enclosing at-rule preludes, outermost first (e.g. '@media (prefers-color-scheme: dark)'). */
  atRules: string[]
  decls: CssDecl[]
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

export function parseCss(src: string): CssRule[] {
  const s = stripComments(src)
  const rules: CssRule[] = []
  let i = 0
  const lineAt = (pos: number): number => s.slice(0, pos).split('\n').length

  /** Reads up to (and past) the first unquoted, unparenthesised char of `stops`. */
  function readUntil(stops: string): { text: string; stop: string; start: number } {
    const start = i
    let depth = 0
    let quote: string | null = null
    while (i < s.length) {
      const c = s[i]!
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (depth === 0 && stops.includes(c)) {
        i++
        return { text: s.slice(start, i - 1), stop: c, start }
      }
      i++
    }
    return { text: s.slice(start), stop: '', start }
  }

  function block(selectors: string[], atRules: string[]): void {
    const decls: CssDecl[] = []
    for (;;) {
      const { text, stop, start } = readUntil(';{}')
      const t = text.trim()
      if (stop === '{') {
        if (t.startsWith('@')) block(selectors, [...atRules, t.replace(/\s+/g, ' ')])
        else block([...selectors, t.replace(/\s+/g, ' ')], atRules)
        continue
      }
      if (t && !t.startsWith('@')) {
        const c = t.indexOf(':')
        if (c > 0) {
          const lead = text.length - text.trimStart().length
          decls.push({ prop: t.slice(0, c).trim().toLowerCase(), value: t.slice(c + 1).trim(), line: lineAt(start + lead) })
        }
      }
      if (stop === '}' || stop === '') break
    }
    if (decls.length) rules.push({ selectors, atRules, decls })
  }

  while (i < s.length) block([], [])
  return rules
}

// =====================================================================================
// Checks
// =====================================================================================

/** CSS Color 4 named colours (148), lowercase. `transparent` and `currentcolor` are keywords, not literals. */
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen'
  ).split(' '),
)

/** Removes var(...) (nested-safe), url(...) and quoted strings from a value, leaving only literal tokens. */
function stripVarsAndStrings(value: string): string {
  let out = value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ').replace(/url\([^)]*\)/gi, ' ')
  for (;;) {
    const m = /var\(/i.exec(out)
    if (!m) break
    let depth = 0
    let j = m.index + 3
    for (; j < out.length; j++) {
      if (out[j] === '(') depth++
      else if (out[j] === ')' && --depth === 0) break
    }
    out = out.slice(0, m.index) + ' ' + out.slice(j + 1)
  }
  return out
}

/** The colour literals in one declaration value (outside var() fallbacks' names, strings and urls). */
export function colourLiterals(value: string): string[] {
  const v = stripVarsAndStrings(value)
  const found: string[] = []
  for (const m of v.matchAll(/#[0-9a-f]{3,8}\b/gi)) found.push(m[0])
  for (const m of v.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) found.push(m[0])
  for (const m of v.matchAll(/-?[a-z_][a-z0-9_-]*/gi)) if (NAMED_COLOURS.has(m[0].toLowerCase())) found.push(m[0])
  return found
}

const GLOBAL_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])
const FONT_SHORTHAND_KEYWORDS = new Set([
  ...GLOBAL_KEYWORDS, 'normal', 'italic', 'oblique', 'bold', 'bolder', 'lighter', 'small-caps',
  'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed', 'semi-expanded', 'expanded', 'extra-expanded',
  'ultra-expanded', 'xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'smaller',
  'larger', 'calc',
])

/** A literal font family in `font-family` or the `font` shorthand (anything but var(--mdr-font-*) and keywords). */
export function literalFontFamily(prop: string, value: string): string | null {
  if (prop === 'font-family') {
    const rest = stripVarsAndStrings(value).replace(/,/g, ' ').trim()
    if (/["']/.test(value.replace(/var\([^)]*\)/g, ''))) return value
    if (!rest) return null
    return rest.split(/\s+/).every((t) => GLOBAL_KEYWORDS.has(t.toLowerCase())) ? null : value
  }
  if (prop === 'font') {
    if (/["']/.test(value.replace(/var\([^)]*\)/g, ''))) return value
    const rest = stripVarsAndStrings(value)
    for (const t of rest.split(/[\s/,]+/).filter(Boolean)) {
      if (/^[-+]?\d/.test(t) || /^\.\d/.test(t)) continue // sizes, weights, line heights
      if (FONT_SHORTHAND_KEYWORDS.has(t.toLowerCase()) || t === '(' || t === ')') continue
      return value
    }
  }
  return null
}

/** A literal radius (anything but var(--mdr-radius*), 0 and percentages). */
export function literalRadius(prop: string, value: string): string | null {
  if (!/^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/.test(prop)) return null
  const rest = stripVarsAndStrings(value).replace(/[/]/g, ' ').trim()
  if (!rest) return null
  return rest.split(/\s+/).every((t) => GLOBAL_KEYWORDS.has(t) || /^0(px|rem|em)?$/.test(t) || /^\d+(\.\d+)?%$/.test(t)) ? null : value
}

/** Every `--mdr-*` name mentioned in a text (CSS, TS, TSX or HTML). */
export function mdrNames(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = []
  const lines = text.split('\n')
  lines.forEach((l, idx) => {
    for (const m of l.matchAll(/--mdr-[a-z0-9-]*[a-z0-9]/gi)) out.push({ name: m[0], line: idx + 1 })
  })
  return out
}

/** Selector parts P2 may never write: anything outside #mdr-editor-host / #mdr-toolbar-host (§12.2.1). */
const P2_FORBIDDEN_SELECTOR = /(^|[\s>+~,(])(:root|html|body)\b|#mdr-(app|scroll)\b|\.mdr-(app|topbar|banner-slot|scroll|canvas|doc-col|rail)\b/
/** Selector parts P3 may never write: anything inside the editor or toolbar hosts (§12.2.1). */
const P3_FORBIDDEN_SELECTOR = /#mdr-(editor|toolbar)-host(\s*>\s*|\s+)\S|\.ProseMirror\b|\[data-testid=["']?mdr-(toolbar|mode-pill|editor|highlight|suggestion)\b/

export interface Violation {
  file: string
  line: number
  what: string
}

export function checkP2Css(file: string, css: string): Violation[] {
  const v: Violation[] = []
  for (const r of parseCss(css)) {
    for (const sel of r.selectors) {
      if (P2_FORBIDDEN_SELECTOR.test(sel)) v.push({ file, line: r.decls[0]?.line ?? 0, what: `P2 selector outside the editor/toolbar hosts: ${sel}` })
    }
    for (const d of r.decls) {
      if (d.prop.startsWith('--mdr-')) v.push({ file, line: d.line, what: `P2 defines a theme token: ${d.prop}` })
      for (const c of colourLiterals(d.value)) v.push({ file, line: d.line, what: `colour literal ${c} in ${d.prop}` })
      const f = literalFontFamily(d.prop, d.value)
      if (f) v.push({ file, line: d.line, what: `literal font family in ${d.prop}: ${f}` })
      const rad = literalRadius(d.prop, d.value)
      if (rad) v.push({ file, line: d.line, what: `literal radius in ${d.prop}: ${rad}` })
    }
  }
  return v
}

export function checkP3Css(file: string, css: string): Violation[] {
  const v: Violation[] = []
  for (const r of parseCss(css)) {
    for (const sel of r.selectors) {
      if (P3_FORBIDDEN_SELECTOR.test(sel)) v.push({ file, line: r.decls[0]?.line ?? 0, what: `P3 selector inside the editor/toolbar hosts: ${sel}` })
    }
    for (const d of r.decls) {
      for (const c of colourLiterals(d.value)) v.push({ file, line: d.line, what: `colour literal ${c} outside tokens.css (${d.prop})` })
    }
  }
  return v
}

export function checkMdrNames(file: string, text: string): Violation[] {
  return mdrNames(text)
    .filter((n) => !TOKEN_SET.has(n.name))
    .map((n) => ({ file, line: n.line, what: `${n.name} is not in THEME_TOKENS` }))
}

type ThemeSlot = 'light' | 'darkMedia' | 'darkAttr' | 'lightAttr'

/** Which theme slot a rule in tokens.css fills, or null if it defines tokens for something else (e.g. a mode). */
function slotOf(r: CssRule): ThemeSlot | null {
  const sel = r.selectors.join(' ').replace(/\s+/g, '')
  const inDarkMedia = r.atRules.some((a) => /prefers-color-scheme:\s*dark/i.test(a))
  if (r.atRules.some((a) => !/prefers-color-scheme:\s*dark/i.test(a))) return null
  if (inDarkMedia) return /^:root(:not\(\[data-theme=["']?light["']?\]\))?$/.test(sel) ? 'darkMedia' : null
  if (/^:root\[data-theme=["']?dark["']?\]$/.test(sel)) return 'darkAttr'
  if (/^:root\[data-theme=["']?light["']?\]$/.test(sel)) return 'lightAttr'
  if (sel === ':root') return 'light'
  return null
}

export function checkTokensCss(file: string, css: string): Violation[] {
  const v: Violation[] = []
  const rules = parseCss(css)
  const defined: Record<ThemeSlot, Set<string>> = { light: new Set(), darkMedia: new Set(), darkAttr: new Set(), lightAttr: new Set() }
  let darkMediaExcludesLight = true
  let darkMediaRules = 0
  for (const r of rules) {
    const slot = slotOf(r)
    if (slot === 'darkMedia') {
      darkMediaRules++
      if (!/:not\(\[data-theme=["']?light["']?\]\)/.test(r.selectors.join(''))) darkMediaExcludesLight = false
    }
    for (const d of r.decls) {
      if (!d.prop.startsWith('--')) continue
      if (d.prop.startsWith('--mdr-') && !TOKEN_SET.has(d.prop)) v.push({ file, line: d.line, what: `${d.prop} is defined but not in THEME_TOKENS` })
      if (slot) defined[slot].add(d.prop)
    }
  }
  const missing = (slot: ThemeSlot, label: string) => {
    for (const t of THEME_TOKENS) if (!defined[slot].has(t)) v.push({ file, line: 0, what: `${t} is not defined ${label}` })
  }
  missing('light', 'on :root (light)')
  missing('darkMedia', 'under @media (prefers-color-scheme: dark)')
  missing('darkAttr', 'under :root[data-theme="dark"]')
  // data-theme="light" must force light: either the dark media rule excludes it, or a light-attribute rule redefines all.
  if (!(darkMediaRules > 0 && darkMediaExcludesLight)) missing('lightAttr', 'under :root[data-theme="light"] (needed because the dark media rule does not exclude it)')
  return v
}

// =====================================================================================
// File discovery
// =====================================================================================

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const rel = (p: string): string => relative(REPO, p).split(sep).join('/')
const webFiles = walk(WEB).filter((p) => /\.(css|ts|tsx|html)$/.test(p))
const cssFiles = webFiles.filter((p) => p.endsWith('.css'))
const isP2 = (p: string): boolean => /^web\/src\/(editor|session)\//.test(rel(p))
const isTokens = (p: string): boolean => p === TOKENS_CSS

/** <style> blocks of an HTML file as CSS (web/index.html is P3's). */
function styleBlocks(html: string): string {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
}

const fmt = (vs: Violation[]): string[] => vs.map((x) => `${x.file}:${x.line} ${x.what}`)

// =====================================================================================
// The suite
// =====================================================================================

describe('theme tokens: the repo', () => {
  it('THEME_TOKENS is a duplicate-free list of --mdr-* names', () => {
    expect(new Set(THEME_TOKENS).size).toBe(THEME_TOKENS.length)
    for (const t of THEME_TOKENS) expect(t).toMatch(/^--mdr-[a-z0-9-]+$/)
  })

  it('web/src/theme/tokens.css exists', () => {
    expect(existsSync(TOKENS_CSS)).toBe(true)
  })

  it('tokens.css defines every THEME_TOKENS name in light, dark (media query) and dark (data-theme), with light forceable', () => {
    expect(fmt(checkTokensCss(rel(TOKENS_CSS), readFileSync(TOKENS_CSS, 'utf8')))).toEqual([])
  })

  it('every --mdr-* name used or defined anywhere under web/ is in THEME_TOKENS', () => {
    const vs = webFiles.flatMap((p) => checkMdrNames(rel(p), readFileSync(p, 'utf8')))
    expect(fmt(vs)).toEqual([])
  })

  it("P2's CSS uses only tokens: no colour, font-family or radius literal, no --mdr-* definition, no selector outside its hosts", () => {
    const vs = cssFiles.filter(isP2).flatMap((p) => checkP2Css(rel(p), readFileSync(p, 'utf8')))
    expect(fmt(vs)).toEqual([])
  })

  it("no colour literal outside tokens.css, and P3's CSS never selects inside the editor or toolbar hosts", () => {
    const p3 = cssFiles.filter((p) => !isP2(p) && !isTokens(p)).flatMap((p) => checkP3Css(rel(p), readFileSync(p, 'utf8')))
    const html = webFiles
      .filter((p) => p.endsWith('.html'))
      .flatMap((p) => checkP3Css(rel(p), styleBlocks(readFileSync(p, 'utf8'))))
    expect(fmt([...p3, ...html])).toEqual([])
  })
})

describe('theme tokens: the checker catches violations (synthetic CSS)', () => {
  it('parses nested at-rules, selectors and declaration lines', () => {
    const rules = parseCss('/* c */\n:root { --mdr-bg: #fff; }\n@media (prefers-color-scheme: dark) {\n  :root { --mdr-bg: #000 }\n}\n.a { .b { color: red; } }')
    expect(rules).toEqual([
      { selectors: [':root'], atRules: [], decls: [{ prop: '--mdr-bg', value: '#fff', line: 2 }] },
      { selectors: [':root'], atRules: ['@media (prefers-color-scheme: dark)'], decls: [{ prop: '--mdr-bg', value: '#000', line: 4 }] },
      { selectors: ['.a', '.b'], atRules: [], decls: [{ prop: 'color', value: 'red', line: 6 }] },
    ])
  })

  it('finds hex, functional and named colour literals, but not tokens, keywords or strings', () => {
    expect(colourLiterals('#fff')).toEqual(['#fff'])
    expect(colourLiterals('1px solid #a1b2c3d4')).toEqual(['#a1b2c3d4'])
    expect(colourLiterals('rgb(0 0 0 / 0.5)')).toEqual(['rgb('])
    expect(colourLiterals('hsla(1, 2%, 3%, .4)')).toEqual(['hsla('])
    expect(colourLiterals('oklch(70% 0.1 200)')).toEqual(['oklch('])
    expect(colourLiterals('0 0 0 2px White')).toEqual(['White'])
    expect(colourLiterals('var(--mdr-text)')).toEqual([])
    expect(colourLiterals('var(--mdr-text, var(--mdr-bg))')).toEqual([])
    expect(colourLiterals('color-mix(in srgb, var(--mdr-author-tj) 20%, transparent)')).toEqual([])
    expect(colourLiterals('currentColor')).toEqual([])
    expect(colourLiterals('"red" url(red.png)')).toEqual([])
    expect(colourLiterals('color 120ms ease-out')).toEqual([])
  })

  it('flags literal font families and radii in P2 CSS', () => {
    expect(literalFontFamily('font-family', 'var(--mdr-font-mono)')).toBeNull()
    expect(literalFontFamily('font-family', 'inherit')).toBeNull()
    expect(literalFontFamily('font-family', 'Menlo, monospace')).not.toBeNull()
    expect(literalFontFamily('font-family', "'SF Mono'")).not.toBeNull()
    expect(literalFontFamily('font', 'italic 600 var(--mdr-ui-size)/1.4 var(--mdr-font-ui)')).toBeNull()
    expect(literalFontFamily('font', '14px Helvetica')).not.toBeNull()
    expect(literalRadius('border-radius', 'var(--mdr-radius-small)')).toBeNull()
    expect(literalRadius('border-radius', 'var(--mdr-radius) var(--mdr-radius) 0 0')).toBeNull()
    expect(literalRadius('border-radius', '50%')).toBeNull()
    expect(literalRadius('border-top-left-radius', '6px')).not.toBeNull()
    expect(literalRadius('padding', '6px')).toBeNull()
  })

  it('checkP2Css reports each violation kind and passes token-only CSS', () => {
    const bad = [
      '.ProseMirror { color: #333; }',
      '.ProseMirror code { font-family: Menlo; border-radius: 3px; }',
      '.hl { background: tomato; }',
      'body .mdr-mode-pill { color: var(--mdr-text); }',
      '.mdr-app .x { color: var(--mdr-text); }',
      '.x { --mdr-accent: var(--mdr-text); }',
    ].join('\n')
    const whats = checkP2Css('p2.css', bad).map((x) => x.what)
    expect(whats.some((w) => w.includes('#333'))).toBe(true)
    expect(whats.some((w) => w.startsWith('literal font family'))).toBe(true)
    expect(whats.some((w) => w.startsWith('literal radius'))).toBe(true)
    expect(whats.some((w) => w.includes('tomato'))).toBe(true)
    expect(whats.filter((w) => w.startsWith('P2 selector outside'))).toHaveLength(2)
    expect(whats.some((w) => w.startsWith('P2 defines a theme token'))).toBe(true)
    const good = '#mdr-editor-host .ProseMirror { color: var(--mdr-text); font-family: var(--mdr-font-body); border-radius: var(--mdr-radius); caret-color: var(--mdr-caret); }\n.mdr-mode-pill[data-mode=suggesting] { background: var(--mdr-suggest); color: var(--mdr-accent-text); opacity: var(--mdr-chrome-opacity); }'
    expect(checkP2Css('p2.css', good)).toEqual([])
  })

  it('checkP3Css flags colour literals and selectors reaching into the editor or toolbar hosts', () => {
    expect(checkP3Css('p3.css', '.mdr-card { color: #000 }')).toHaveLength(1)
    expect(checkP3Css('p3.css', '#mdr-editor-host p { margin: 0 }')).toHaveLength(1)
    expect(checkP3Css('p3.css', '.mdr-app .ProseMirror { margin: 0 }')).toHaveLength(1)
    expect(checkP3Css('p3.css', '#mdr-toolbar-host > button { margin: 0 }')).toHaveLength(1)
    expect(checkP3Css('p3.css', '#mdr-editor-host { min-height: 50vh }')).toEqual([])
    expect(checkP3Css('p3.css', '.mdr-app[data-mode=suggesting] .mdr-doc-col { border-left: 2px solid var(--mdr-suggest) }')).toEqual([])
  })

  it('checkMdrNames flags unknown token names in any language', () => {
    expect(checkMdrNames('x.ts', "el.style.setProperty('--mdr-chrome-opacity', '1')")).toEqual([])
    expect(checkMdrNames('x.ts', "el.style.setProperty('--mdr-chrome-opactiy', '1')")).toHaveLength(1)
    expect(checkMdrNames('x.css', '.a { color: var(--mdr-txt) }')).toHaveLength(1)
    expect(checkMdrNames('x.ts', 'const p = `--mdr-${name}`')).toEqual([])
  })

  it('checkTokensCss requires every token in every theme slot and that light can be forced', () => {
    const all = (v: string) => THEME_TOKENS.map((t) => `${t}: ${v};`).join(' ')
    const full = `:root { ${all('#fff')} }\n@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${all('#000')} } }\n:root[data-theme="dark"] { ${all('#000')} }`
    expect(checkTokensCss('t.css', full)).toEqual([])
    // the dark media rule does not exclude data-theme="light", and no light-attribute rule exists
    const noForce = full.replace(':root:not([data-theme="light"])', ':root')
    expect(checkTokensCss('t.css', noForce).length).toBe(THEME_TOKENS.length)
    expect(checkTokensCss('t.css', `${noForce}\n:root[data-theme="light"] { ${all('#fff')} }`)).toEqual([])
    // one token missing from the dark attribute rule
    const missingOne = full.replace(/(:root\[data-theme="dark"\] \{ )--mdr-bg: #000;/, '$1')
    expect(checkTokensCss('t.css', missingOne).map((x) => x.what)).toEqual(['--mdr-bg is not defined under :root[data-theme="dark"]'])
    // an unknown token definition
    expect(checkTokensCss('t.css', `${full}\n:root { --mdr-extra: 1px; }`).map((x) => x.what)).toEqual(['--mdr-extra is defined but not in THEME_TOKENS'])
  })
})
