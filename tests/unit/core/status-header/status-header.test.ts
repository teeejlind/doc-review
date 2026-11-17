// tests/unit/core/status-header/status-header.test.ts (P2; CONTRACTS §12.12 B). detectStatusHeader over the fixtures,
// synthetic edge cases and the corpus, plus agreement between the loaded-file path and the editor's live path.
import { describe, expect, it } from 'vitest'
import { createMd, type Md } from '../../../../core/md/index'
import { load } from '../../../../core/splice/load'
import { detectStatusHeader, detectStatusHeaderInDoc, statusPhrases } from '../../../../core/status-header'
import { corpusFiles, fixtureText } from './corpus'

let mdP: Promise<Md> | null = null
const md = (): Promise<Md> => (mdP ??= createMd())

async function detect(text: string): Promise<ReturnType<typeof detectStatusHeader>> {
  const L = load(await md(), text)
  const a = detectStatusHeader(L)
  const live = detectStatusHeaderInDoc(L.doc)
  // the live path (no source) must agree with the source path on a freshly loaded doc
  expect(live?.info ?? null).toEqual(a)
  return a
}

describe('detectStatusHeader: fixtures (§12.12 B)', () => {
  it('syn__status-header.md: bold label line; every bold label becomes a field', async () => {
    const h = await detect(fixtureText('syn__status-header.md'))
    expect(h).toEqual({
      index: 1,
      rule: 'label',
      status: 'draft only · needs Dana Reyes sign-off (legal)',
      phrases: ['draft only', 'needs Dana Reyes sign-off (legal)'],
      fields: [
        { label: 'Status', value: 'draft only · needs Dana Reyes sign-off (legal)' },
        { label: 'Owner', value: 'TJ' },
        { label: 'Updated', value: '2026-10-15' },
      ],
    })
  })

  it('the `> **Status:**` blockquote form; index is the blockquote entry', async () => {
    const h = await detect(fixtureText('syn__status-blockquote.md'))
    expect(h?.index).toBe(1)
    expect(h?.rule).toBe('label')
    expect(h?.phrases).toEqual(['draft only', 'needs legal review'])
  })

  it('the backtick form: backticks never reach status, phrases or fields', async () => {
    const h = await detect(fixtureText('syn__status-backtick.md'))
    expect(h?.status).toBe('draft only · needs Dana Reyes sign-off (legal)')
    expect(h?.phrases).toEqual(['draft only', 'needs Dana Reyes sign-off (legal)'])
    expect(h?.fields).toContainEqual({ label: 'Owner', value: 'TJ' })
  })

  it('the plain `Status: draft only — …` form (capital S, no bold)', async () => {
    const h = await detect(fixtureText('syn__status-plain.md'))
    expect(h).toMatchObject({ index: 1, rule: 'label', status: 'draft only — waiting on the Q3 numbers', fields: [] })
    expect(h?.phrases).toEqual(['draft only — waiting on the Q3 numbers'])
  })

  it('the version-line phrase form', async () => {
    const h = await detect(fixtureText('syn__status-version-line.md'))
    expect(h).toMatchObject({ index: 1, rule: 'phrase', status: 'draft only', phrases: ['draft only'] })
  })

  it('ignores a **Status:** paragraph beyond the scan window and Status inside a heading', async () => {
    expect(await detect(fixtureText('syn__status-beyond-window.md'))).toBeNull()
    expect(await detect(fixtureText('syn__status-in-heading.md'))).toBeNull()
  })

  it('frontmatter is skipped before the window starts', async () => {
    const h = await detect(fixtureText('syn__frontmatter-complex.md'))
    expect(h).toMatchObject({ index: 1, rule: 'label', status: 'draft only · potential style issues flagged: none' })
  })
})

describe('detectStatusHeader: rules', () => {
  it('colon outside the bold, underscores, lowercase bold label; plain lowercase is not a label', async () => {
    expect((await detect('# T\n\n**Status**: draft only\n'))?.status).toBe('draft only')
    expect((await detect('# T\n\n__Status:__ needs legal review\n'))?.status).toBe('needs legal review')
    expect((await detect('# T\n\n**status:** blocked: missing claim\n'))?.rule).toBe('label')
    const lower = await detect('# T\n\nstatus: shipped\n')
    expect(lower).toBeNull()
    // a bold label with nothing after it is not a status line
    expect(await detect('# T\n\n**Status:**\n')).toBeNull()
  })

  it('the label rule beats an earlier phrase candidate; the phrase rule only looks at the first three blocks', async () => {
    const h = await detect('# T\n\nThis is a draft only memo.\n\n**Status:** approved per receipt\n')
    expect(h).toMatchObject({ index: 2, rule: 'label', status: 'approved per receipt' })
    expect(await detect('# T\n\nOne.\n\nTwo.\n\nThree.\n\nA draft only line.\n')).toBeNull()
    expect((await detect('# T\n\nOne.\n\nTwo.\n\nA draft only line · internal\n'))?.status).toBe('draft only line')
  })

  it('only the first heading is free; a second heading counts toward the window', async () => {
    const md6 = '# A\n\n## B\n\n1\n\n2\n\n3\n\n4\n\n5\n\n**Status:** draft only\n'
    expect(await detect(md6)).toBeNull()
    const md5 = '# A\n\n## B\n\n1\n\n2\n\n3\n\n4\n\n**Status:** draft only\n'
    expect((await detect(md5))?.index).toBe(6)
  })

  it('status is cut at 80 chars with an ellipsis; a bracketed annotation keeps its separator', async () => {
    const long = 'x'.repeat(120)
    const h = await detect(`# T\n\n**Status:** ${long}\n`)
    expect(h?.status.length).toBe(80)
    expect(h?.status.endsWith('…')).toBe(true)
    expect(statusPhrases('draft only · needs Dana Reyes sign-off (legal) [with Dana · since 10/2]')).toEqual([
      'draft only', 'needs Dana Reyes sign-off (legal) [with Dana · since 10/2]',
    ])
    expect(statusPhrases(' · a ·  · b · ')).toEqual(['a', 'b'])
  })

  it('a paragraph with several bold labels on one line: each value stops at the next label', async () => {
    const h = await detect('# T\n\n**Status:** `draft only` · **Owner:** TJ · **Lane:** PS\n')
    expect(h?.fields).toEqual([
      { label: 'Status', value: 'draft only' },
      { label: 'Owner', value: 'TJ' },
      { label: 'Lane', value: 'PS' },
    ])
    expect(h?.status).toBe('draft only')
  })
})

describe('detectStatusHeader: corpus', () => {
  it('runs over every corpus file, the live path agrees, and reports the detection count', async () => {
    const { files, realPresent } = corpusFiles()
    const m = await md()
    let detected = 0
    let real = 0
    let realDetected = 0
    const byRule = { label: 0, phrase: 0 }
    for (const f of files) {
      const L = load(m, f.text)
      const h = detectStatusHeader(L)
      expect(detectStatusHeaderInDoc(L.doc)?.info ?? null, f.name).toEqual(h)
      if (f.kind === 'real') real++
      if (!h) continue
      detected++
      byRule[h.rule]++
      if (f.kind === 'real') realDetected++
      expect(h.status.length, f.name).toBeLessThanOrEqual(80)
      expect(h.status, f.name).not.toMatch(/`/)
      expect(h.phrases.length, f.name).toBeGreaterThan(0)
    }
    console.log(`[status-header] detected ${detected}/${files.length} corpus files (label ${byRule.label}, phrase ${byRule.phrase})` +
      (realPresent ? `; real corpus ${realDetected}/${real}` : '; real corpus absent'))
    expect(detected).toBeGreaterThan(0)
  })
})
