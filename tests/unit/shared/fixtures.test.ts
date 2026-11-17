// Integrator (day 0): the committed fixture docs are byte-exact and listed in tests/fixtures/index.ts (CONTRACTS §2.4
// item 7). A git EOL rewrite, an editor stripping trailing whitespace or a BOM, or an unlisted fixture fails here.
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BLOCK_HTML_FIXTURE, FIXTURE_DOCS, FIXTURES_DIR, fixtureBytes, fixtureText } from '../../fixtures/index'

const PROTECTED = ['approvals', 'registry', 'signed', 'filed']

describe('tests/fixtures/docs', () => {
  it('the manifest lists exactly the .md files on disk', () => {
    const onDisk = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.md')).sort()
    expect(FIXTURE_DOCS.map((d) => d.file).sort()).toEqual(onDisk)
  })

  it('no fixture name contains a protected segment', () => {
    for (const d of FIXTURE_DOCS) for (const p of PROTECTED) expect(d.file).not.toContain(p)
  })

  for (const d of FIXTURE_DOCS) {
    it(`${d.file}: bytes, BOM, EOL and final EOL match the manifest`, () => {
      const b = fixtureBytes(d.file)
      expect(b.length).toBe(d.bytes)
      const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
      expect(bom).toBe(d.bom)
      const text = fixtureText(d.file)
      expect(Buffer.from((bom ? '﻿' : '') + text, 'utf8').equals(b)).toBe(true) // lossless UTF-8
      const crlf = (text.match(/\r\n/g) ?? []).length
      const lf = (text.match(/\n/g) ?? []).length - crlf
      const eol = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none'
      expect(eol).toBe(d.eol)
      expect(/\n$/.test(text)).toBe(d.finalEol)
    })
  }

  it('the block-HTML fixture has a <div> block, an HTML comment, a <details> pair and inline <span>s (§2.4 item 7)', () => {
    const t = fixtureText(BLOCK_HTML_FIXTURE)
    expect(t).toMatch(/^<div[^>]*>$/m)
    expect(t).toMatch(/^<!--.*-->$/m)
    expect(t).toMatch(/^<details>$/m)
    expect(t).toMatch(/^<\/details>$/m)
    expect((t.match(/<span[^>]*>/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('trailing whitespace survives', () => {
    expect(fixtureText('syn__trailing-whitespace.md')).toContain('two spaces  \n')
    expect(fixtureText('syn__trailing-whitespace.md')).toContain('Trailing tab\t\n')
  })
})
