// tests/unit/web/theme/contrast.test.ts (P3; CONTRACTS §12.2.2, R7.4).
//
// Parses web/src/theme/tokens.css and requires WCAG AA in BOTH themes: >= 4.5:1 for the text pairs and >= 3:1 for
// the UI pairs §12.2.2 lists. It also holds the two dark definitions (media query and data-theme) identical, and
// checks the extra text pairs the shell and cards will render (faint and muted text on surfaces, status colours),
// since p3-a11y's axe pass flags any rendered text below 4.5:1.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '../../../../shared/constants'

/** vitest runs from the repo root; jsdom's URL makes import.meta.url unusable for file paths here. */
const TOKENS_CSS = join(process.cwd(), 'web/src/theme/tokens.css')

// ------------------------------------------------------------------ colour maths (WCAG 2.x)

export function parseHex(v: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim())
  if (!m) return null
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: string, b: string): number {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) throw new Error(`not a hex colour: ${ca ? b : a}`)
  const la = luminance(ca)
  const lb = luminance(cb)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ------------------------------------------------------------------ tokens.css reader

type Theme = Map<string, string>

/** Every rule as (at-rule chain + selector) → its custom-property declarations. */
function readRules(css: string): Array<{ context: string; decls: Theme }> {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Array<{ context: string; decls: Theme }> = []
  const stack: string[] = []
  let buf = ''
  for (const ch of s) {
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '))
      buf = ''
    } else if (ch === '}') {
      const decls: Theme = new Map()
      for (const d of buf.split(';')) {
        const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i.exec(d)
        if (m) decls.set(m[1]!, m[2]!)
      }
      if (decls.size) out.push({ context: stack.join(' » '), decls })
      stack.pop()
      buf = ''
    } else buf += ch
  }
  return out
}

/** Resolves var(--x) references inside one theme (e.g. --mdr-caret: var(--mdr-text)). */
function resolve(theme: Theme, value: string, depth = 0): string {
  if (depth > 8) throw new Error(`var() cycle at ${value}`)
  return value.replace(/var\((--[a-z0-9-]+)\)/gi, (_, name: string) => {
    const v = theme.get(name)
    if (v === undefined) throw new Error(`${name} is undefined`)
    return resolve(theme, v, depth + 1)
  })
}

function themes(): { light: Theme; darkMedia: Theme; darkAttr: Theme } {
  const rules = readRules(readFileSync(TOKENS_CSS, 'utf8'))
  const pick = (context: string): Theme => {
    const r = rules.find((x) => x.context === context)
    if (!r) throw new Error(`tokens.css has no rule ${context}`)
    return r.decls
  }
  return {
    light: pick(':root'),
    darkMedia: pick('@media (prefers-color-scheme: dark) » :root:not([data-theme="light"])'),
    darkAttr: pick(':root[data-theme="dark"]'),
  }
}

// ------------------------------------------------------------------ the pairs (§12.2.2)

const AA_TEXT: Array<[string, string]> = [
  ['text', 'bg'], ['text-muted', 'bg'], ['text', 'surface'], ['text', 'surface-raised'], ['accent-text', 'accent'],
  ['insert', 'bg'], ['delete', 'bg'], ['text', 'author-tj-soft'], ['text', 'author-claude-soft'], ['text', 'suggest-soft'],
  ['text', 'conflict-soft'],
]
const AA_UI: Array<[string, string]> = [
  ['focus', 'bg'], ['suggest', 'bg'], ['author-tj', 'bg'], ['author-claude', 'bg'], ['rule', 'bg'],
  // an outlined button's border, against the page, its own surface and the hover fill it turns to (T2 polish #40)
  ['control-border', 'bg'], ['control-border', 'surface'], ['control-border', 'hover'],
]
/** Not in §12.2.2's list, but rendered as text by P3 (timestamps, card meta, banners, links in cards). */
const P3_TEXT: Array<[string, string]> = [
  ['text-faint', 'bg'], ['text-faint', 'surface'], ['text-faint', 'surface-raised'], ['text-muted', 'surface'],
  ['text-muted', 'surface-raised'], ['accent', 'bg'], ['accent', 'surface'], ['warn', 'bg'], ['warn', 'surface'],
  ['danger', 'bg'], ['danger', 'surface'], ['success', 'bg'], ['success', 'surface'], ['author-tj', 'surface'],
  ['author-claude', 'surface'], ['insert', 'surface'], ['delete', 'surface'], ['text', 'hover'], ['text', 'selection'],
  ['text', 'hl-active'], ['author-external', 'bg'],
  // tracked-change text sits on the author fills and on the active highlight; pill text on its soft fill; conflict text
  ['insert', 'author-tj-soft'], ['insert', 'author-claude-soft'], ['insert', 'hl-active'], ['delete', 'hl-active'],
  ['suggest', 'suggest-soft'], ['conflict', 'conflict-soft'], ['text-faint', 'hover'], ['text-muted', 'hover'],
]

const colour = (t: Theme, name: string): string => resolve(t, t.get(`--mdr-${name}`) ?? `<missing --mdr-${name}>`)

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#fff', '#fff')).toBeCloseTo(1, 5)
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5)
    expect(contrast('#ffffff', '#777777')).toBe(contrast('#777777', '#ffffff'))
    expect(parseHex('rgb(0 0 0)')).toBeNull()
  })
})

describe('tokens.css contrast (AA, both themes)', () => {
  const t = themes()
  const cases: Array<[string, Theme]> = [['light', t.light], ['dark (prefers-color-scheme)', t.darkMedia], ['dark (data-theme)', t.darkAttr]]

  for (const [label, theme] of cases) {
    it(`${label}: text pairs >= 4.5:1`, () => {
      const fails = AA_TEXT.map(([fg, bg]) => [`${fg}/${bg}`, contrast(colour(theme, fg), colour(theme, bg))] as const).filter(([, r]) => r < 4.5)
      expect(fails).toEqual([])
    })
    it(`${label}: UI pairs >= 3:1`, () => {
      const fails = AA_UI.map(([fg, bg]) => [`${fg}/${bg}`, contrast(colour(theme, fg), colour(theme, bg))] as const).filter(([, r]) => r < 3)
      expect(fails).toEqual([])
    })
    it(`${label}: text P3 renders beyond the contract list >= 4.5:1`, () => {
      const fails = P3_TEXT.map(([fg, bg]) => [`${fg}/${bg}`, contrast(colour(theme, fg), colour(theme, bg))] as const).filter(([, r]) => r < 4.5)
      expect(fails).toEqual([])
    })
    it(`${label}: the caret resolves to a colour with >= 3:1 against the page`, () => {
      expect(contrast(colour(theme, 'caret'), colour(theme, 'bg'))).toBeGreaterThanOrEqual(3)
    })
  }

  it('the two dark definitions are identical (media query and data-theme="dark")', () => {
    expect(Object.fromEntries(t.darkAttr)).toEqual(Object.fromEntries(t.darkMedia))
  })

  it('every THEME_TOKENS name is defined in each theme; colour tokens are opaque hex values', () => {
    const colourTokens = THEME_TOKENS.filter((n) => !/font|size|leading|measure|radius|shadow|z-popover|chrome-opacity|caret/.test(n))
    for (const theme of [t.light, t.darkMedia, t.darkAttr]) {
      for (const n of THEME_TOKENS) expect(theme.has(n), n).toBe(true)
      for (const n of colourTokens) expect(parseHex(theme.get(n)!), `${n}: ${theme.get(n)}`).not.toBeNull()
    }
  })

  it('typography tokens carry the §12.2.2 / §12.2.3 values', () => {
    for (const theme of [t.light, t.darkMedia, t.darkAttr]) {
      expect(theme.get('--mdr-body-size')).toBe('19px')
      expect(theme.get('--mdr-body-leading')).toBe('1.6')
      expect(theme.get('--mdr-measure')).toBe('68ch')
      expect(theme.get('--mdr-ui-size')).toBe('14px')
      expect(theme.get('--mdr-ui-size-small')).toBe('12px')
      expect(theme.get('--mdr-font-body')).toBe("'Source Serif 4 Variable', Georgia, serif")
      expect(theme.get('--mdr-font-ui')).toBe("-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Segoe UI', Arial, sans-serif")
      expect(theme.get('--mdr-font-mono')).toBe("ui-monospace, 'SF Mono', Menlo, Consolas, 'Cascadia Mono', monospace")
      expect(theme.get('--mdr-chrome-opacity')).toBe('1')
    }
  })

  it('Suggesting mode switches the caret to the suggest colour', () => {
    const rules = readRules(readFileSync(TOKENS_CSS, 'utf8'))
    const mode = rules.find((r) => r.context === '.mdr-app[data-mode="suggesting"]')
    expect(mode?.decls.get('--mdr-caret')).toBe('var(--mdr-suggest)')
  })
})
