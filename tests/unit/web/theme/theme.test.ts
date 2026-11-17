// tests/unit/web/theme/theme.test.ts (P3; CONTRACTS §12.0.1, §12.2.2, R7.1).
import { afterEach, describe, expect, it } from 'vitest'
import { forcedTheme, installTheme } from '../../../../web/src/theme/theme'

function media(matches: boolean) {
  const subs = new Set<() => void>()
  const q = {
    matches,
    addEventListener: (_: string, cb: () => void) => subs.add(cb),
    removeEventListener: (_: string, cb: () => void) => subs.delete(cb),
  }
  return {
    mm: () => q as unknown as MediaQueryList,
    flip(m: boolean) {
      q.matches = m
      subs.forEach((cb) => cb())
    },
    subs,
  }
}

afterEach(() => {
  delete document.documentElement.dataset.theme
})

describe('forcedTheme', () => {
  it('reads ?theme= first, then localStorage mdr:theme; anything else is no force', () => {
    expect(forcedTheme({ search: '?file=a.md&theme=dark' }, null)).toBe('dark')
    expect(forcedTheme({ search: '?theme=light' }, { getItem: () => 'dark' })).toBe('light')
    expect(forcedTheme({ search: '' }, { getItem: (k) => (k === 'mdr:theme' ? 'dark' : null) })).toBe('dark')
    expect(forcedTheme({ search: '?theme=sepia' }, { getItem: () => 'blue' })).toBeNull()
    expect(forcedTheme(null, null)).toBeNull()
  })

  it('a throwing storage is treated as absent', () => {
    expect(forcedTheme({ search: '' }, { getItem: () => { throw new Error('denied') } })).toBeNull()
  })
})

describe('installTheme', () => {
  it('follows the system: #mdr-app[data-theme] mirrors prefers-color-scheme, <html> carries no data-theme', () => {
    const app = document.createElement('div')
    const m = media(false)
    const t = installTheme({ doc: document, app, matchMedia: m.mm, loc: { search: '' }, storage: null })
    expect(app.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    m.flip(true)
    expect(app.dataset.theme).toBe('dark')
    expect(t.theme()).toBe('dark')
    t.dispose()
    expect(m.subs.size).toBe(0)
  })

  it('a forced theme sets <html data-theme> (which tokens.css honours) and ignores the system', () => {
    const app = document.createElement('div')
    const m = media(true)
    installTheme({ doc: document, app, matchMedia: m.mm, loc: { search: '?theme=light' }, storage: null })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(app.dataset.theme).toBe('light')
    m.flip(false)
    m.flip(true)
    expect(app.dataset.theme).toBe('light')
  })
})
