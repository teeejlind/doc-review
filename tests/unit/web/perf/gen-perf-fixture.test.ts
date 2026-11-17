// @vitest-environment node
// tests/unit/web/perf/gen-perf-fixture.test.ts (P3; CONTRACTS §11.7 "Fixture").
//
// The perf fixture: a 10k-word doc with frontmatter, a body status header, mixed headings, lists and two tables, and
// 50 threads (40 comments, 10 Claude suggestions) spread through it, written through a DocStore so the sidecar is the
// §4 format. Runs in node (the script writes files through the store).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countWords, PERF_COMMENTS, PERF_SUGGESTIONS, PERF_TARGET_WORDS, perfMarkdown, writePerfFixture } from '../../../../scripts/gen-perf-fixture'

describe('perfMarkdown', () => {
  const doc = perfMarkdown()

  it('is a 10k-word doc with the §11.7 structure', () => {
    expect(doc.wordCount).toBeGreaterThanOrEqual(PERF_TARGET_WORDS)
    expect(doc.wordCount).toBeLessThan(PERF_TARGET_WORDS * 1.2)
    expect(doc.markdown.startsWith('---\ntitle: ')).toBe(true)
    expect(doc.markdown).toContain('\nstatus: Draft for review\n')
    expect(doc.markdown).toContain('\n**Status:** Draft v3')
    expect(doc.markdown.match(/^## /gm)!.length).toBeGreaterThan(10)
    expect(doc.markdown.match(/^### /gm)!.length).toBeGreaterThan(1)
    expect(doc.markdown.match(/^\| --- \| ---: \| :---: \| --- \|$/gm)).toHaveLength(2)
    expect(doc.markdown).toMatch(/^- \[x\] /m)
    expect(doc.markdown).toMatch(/^1\. /m)
    expect(doc.markdown).toMatch(/^> /m)
  })

  it('is deterministic', () => {
    expect(perfMarkdown().markdown).toBe(doc.markdown)
    expect(perfMarkdown(7).markdown).not.toBe(doc.markdown)
  })

  it('has 40 comment quotes and 10 suggestion quotes, each unique in the text and spread through it', () => {
    expect(doc.commentQuotes).toHaveLength(PERF_COMMENTS)
    expect(doc.suggestions).toHaveLength(PERF_SUGGESTIONS)
    const at: number[] = []
    for (const q of [...doc.commentQuotes, ...doc.suggestions.map((s) => s.quote)]) {
      const first = doc.markdown.indexOf(q)
      expect(first, q).toBeGreaterThan(0)
      expect(doc.markdown.indexOf(q, first + 1), q).toBe(-1)
      at.push(first)
    }
    at.sort((a, b) => a - b)
    // spread: the anchors cover the whole doc, not one corner of it
    expect(at[0]!).toBeLessThan(doc.markdown.length * 0.05)
    expect(at.at(-1)!).toBeGreaterThan(doc.markdown.length * 0.9)
  })

  it('counts body words only', () => {
    expect(countWords('---\ntitle: a b c\n---\n\nOne two three.\n')).toBe(3)
  })
})

describe('writePerfFixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdr-perf-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes perf.md, a §4 sidecar with 50 threads, and fixture.json', async () => {
    const info = await writePerfFixture({ dir })
    expect(info.comments).toHaveLength(PERF_COMMENTS)
    expect(info.suggestions).toHaveLength(PERF_SUGGESTIONS)
    expect(info.threads).toHaveLength(PERF_COMMENTS + PERF_SUGGESTIONS)
    expect(readFileSync(info.abs, 'utf8')).toBe(perfMarkdown().markdown)
    const lines = readFileSync(join(info.root, 'perf.md.review.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { type: string; by?: string; schema?: string })
    expect(lines[0]).toMatchObject({ type: 'header', schema: 'mdr.sidecar/2' })
    expect(lines.filter((l) => l.type === 'comment.add')).toHaveLength(PERF_COMMENTS)
    expect(lines.filter((l) => l.type === 'suggestion.add' && l.by === 'Claude')).toHaveLength(PERF_SUGGESTIONS)
    expect(lines.filter((l) => l.type === 'comment.reply' && l.by === 'TJ').length).toBeGreaterThanOrEqual(10)
    const meta = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as { wordCount: number; threads: string[] }
    expect(meta.wordCount).toBe(info.wordCount)
    expect(meta.threads).toHaveLength(50)
  })
})
