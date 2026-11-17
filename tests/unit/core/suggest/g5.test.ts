// tests/unit/core/suggest/g5.test.ts (P2; CONTRACTS §1.3 "corpus", §3.4 G5, §6.4). `npm run corpus` runs it after
// P1's runner: `vitest run --project node tests/unit/core/suggest/g5.test.ts`; `npm test` runs it too.
//
// Gate G5 over the S2 suggest suite plus a slice of the edit suite, on the synthetic corpus (tests/fixtures/docs/,
// tests/corpus/fixtures/synthetic/) and the real corpus (tests/corpus/fixtures/real/, gitignored; skipped with a note
// when absent):
//   (a) extract(hydrate(base, r)) round-trips r semantically (same base bytes, nodeEq proposed), for Claude records
//       built with fromQuote (a word replaced) and fromBlock (a block rewritten);
//   (b) applyToSource(base, extract(live, id)).text parses nodeEq to "live with only id applied" (normalized through
//       an Editing-mode save, since markdown can't hold e.g. a trailing space), for TJ's Suggesting-mode edits:
//       replace a word, delete a word, split a paragraph, add a paragraph.
// Plus the base invariant every case shares: baseDoc(live) plans to no ops (the .md never sees a suggestion).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import { load } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { extract, sameProposal } from '../../../../core/suggest/extract'
import { onlyApplied, revertAll } from '../../../../core/suggest/guards'
import { hydrate } from '../../../../core/suggest/hydrate'
import { applyToSource, fromBlock, fromQuote } from '../../../../core/suggest/record'
import { StoreError } from '../../../../shared/errors'
import type { SuggestionId } from '../../../../shared/types'
import { docOf, record, sameContent, savedDoc, userDispatch, type Doc } from './helpers'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SOURCES = [
  { kind: 'synthetic', dir: join(ROOT, 'tests/fixtures/docs') },
  { kind: 'synthetic', dir: join(ROOT, 'tests/corpus/fixtures/synthetic') },
  { kind: 'real', dir: join(ROOT, 'tests/corpus/fixtures/real') },
] as const
const WORDS_PER_FILE = 4

interface CorpusFile { name: string; kind: string; text: string }

function corpus(): { files: CorpusFile[]; realPresent: boolean } {
  const files: CorpusFile[] = []
  let realPresent = false
  for (const s of SOURCES) {
    if (!existsSync(s.dir)) continue
    for (const name of readdirSync(s.dir).filter((n) => n.endsWith('.md')).sort()) {
      const raw = readFileSync(join(s.dir, name))
      const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(bom ? 3 : 0))
      } catch {
        continue
      }
      files.push({ name, kind: s.kind, text })
      if (s.kind === 'real') realPresent = true
    }
  }
  return { files, realPresent }
}

/** Up to `max` plain words (4+ letters, no link / code marks) in non-code textblocks, evenly spread. */
function words(doc: PMNode, max: number): Array<{ from: number; to: number; word: string; top: number }> {
  const all: Array<{ from: number; to: number; word: string; top: number }> = []
  doc.forEach((top, off, topIndex) => {
    top.descendants((n, pos, parent) => {
      if (!n.isText || parent?.type.name === 'code_block') return true
      if (n.marks.some((m) => ['inlineCode', 'link'].includes(m.type.name))) return false
      const re = /\b[A-Za-z]{4,}\b/g
      for (let m = re.exec(n.text!); m; m = re.exec(n.text!)) {
        all.push({ from: off + 1 + pos + m.index, to: off + 1 + pos + m.index + m[0].length, word: m[0], top: topIndex })
      }
      return false
    })
  })
  if (all.length <= max) return all
  const step = all.length / max
  return Array.from({ length: max }, (_, i) => all[Math.floor(i * step)]!)
}

const mangle = (w: string): string => w.split('').reverse().join('') + 'x'

function isExpectedRefusal(e: unknown): boolean {
  return e instanceof StoreError && ['QUOTE_AMBIGUOUS', 'QUOTE_NOT_FOUND', 'UNANCHORABLE_TARGET', 'BLOCK_NOT_FOUND'].includes(e.code)
}

/** (b): applyToSource(base, extract(live, id)) vs live-with-only-id, both through markdown. */
function checkTjRecord(d: Doc, id: SuggestionId): string | null {
  if (planSave(d.md, d.L, revertAll(d.state.doc).doc).length !== 0) return 'baseDoc(live) plans ops'
  const u = extract(d.state, id, { md: d.md, loaded: d.L })
  if (!u) {
    // no representable change (e.g. a split at a block's very start only adds an empty paragraph): nothing to send
    return sameContent(savedDoc(d, onlyApplied(d.state.doc, new Set([id])).doc), d.L.doc) ? null : 'extract returned null'
  }
  const r = applyToSource(d.md, d.L, { ...u, range: { ...u.range, rev: 0 }, hunks: [] })
  const got = load(d.md, r.text).doc
  const want = savedDoc(d, onlyApplied(d.state.doc, new Set([id])).doc)
  return sameContent(got, want) ? null : `splice != live-with-only-id (proposed ${JSON.stringify(u.proposed.slice(0, 80))})`
}

const { files, realPresent } = corpus()

// the real corpus (52 workspace docs, gitignored) takes minutes on the day-0 oracle-backed planSave
const CORPUS_TIMEOUT_MS = realPresent ? 600_000 : 60_000

describe('G5 suggestion round trip (§6.4)', () => {
  it('the corpus is there (real docs are optional and gitignored)', () => {
    expect(files.length).toBeGreaterThan(20)
    if (!realPresent) console.warn('[g5] tests/corpus/fixtures/real/ absent: real corpus skipped (QA gate needs it)')
  })

  it('(a) extract(hydrate(base, r)) round-trips Claude records', async () => {
    const failures: string[] = []
    let checked = 0
    for (const f of files) {
      const d = await docOf(f.text)
      const cands = words(d.L.doc, WORDS_PER_FILE)
      const records = []
      for (const w of cands) {
        try {
          records.push(record(fromQuote(d.md, d.L, { quote: w.word, replace: mangle(w.word), occurrence: 1 })))
        } catch (e) {
          if (!isExpectedRefusal(e)) throw e
        }
      }
      // a whole-block rewrite of the first paragraph or heading (the edit suite's block replace)
      const bi = d.L.blocks.findIndex((b) => b.kind === 'md' && (b.mdType === 'paragraph' || b.mdType === 'heading'))
      if (bi >= 0) {
        const src = d.L.src.slice(d.L.blocks[bi]!.start, d.L.blocks[bi]!.end)
        try {
          records.push(record(fromBlock(d.md, d.L, bi, src.replace(/([A-Za-z]{4,})/, (m) => mangle(m)))))
        } catch (e) {
          if (!isExpectedRefusal(e)) throw e
        }
      }
      for (const r of records) {
        if (r.base === r.proposed) continue
        const h = hydrate(d.state, r, { md: d.md, loaded: d.L })
        if (!('tr' in h)) continue // unplaced (SCHEMA etc.) is a card, not a round trip
        const live = d.state.apply(h.tr)
        if (planSave(d.md, d.L, revertAll(live.doc).doc).length !== 0) {
          failures.push(`${f.name}: hydrate changed the base (${r.base.slice(0, 40)})`)
          continue
        }
        const u = extract(live, r.id, { md: d.md, loaded: d.L })
        checked++
        if (!u) failures.push(`${f.name}: extract null for ${JSON.stringify(r.proposed.slice(0, 60))}`)
        else if (u.base !== r.base || !sameProposal(d.md, u.proposed, r.proposed)) {
          failures.push(`${f.name}: ${JSON.stringify(r.base.slice(0, 50))} -> ${JSON.stringify(r.proposed.slice(0, 50))} came back ${JSON.stringify(u.proposed.slice(0, 50))}`)
        }
      }
    }
    expect(failures).toEqual([])
    expect(checked).toBeGreaterThan(30)
  }, CORPUS_TIMEOUT_MS)

  it("(b) applyToSource(base, extract(live, id)) equals live with only id applied, for TJ's Suggesting-mode edits", async () => {
    const failures: string[] = []
    let checked = 0
    for (const f of files) {
      const base = await docOf(f.text, { suggesting: true })
      const cands = words(base.L.doc, WORDS_PER_FILE)
      for (const [k, w] of cands.entries()) {
        const id = `s_TJ${k}` as SuggestionId
        const cases: Array<[string, (d: Doc) => Doc]> = [
          ['replace', (d) => userDispatch(d, d.state.tr.insertText(mangle(w.word), w.from, w.to), () => id)],
          ['delete', (d) => userDispatch(d, d.state.tr.delete(w.from, w.to), () => id)],
          ['split', (d) => userDispatch(d, d.state.tr.setSelection(TextSelection.create(d.state.doc, w.from)).split(w.from), () => id)],
        ]
        const top = base.L.doc.child(w.top)
        if (top.type.name === 'paragraph') {
          let end = 0
          base.L.doc.forEach((_n, off, i) => {
            if (i === w.top) end = off + top.nodeSize - 1
          })
          cases.push(['add-paragraph', (d) => userDispatch(d, d.state.tr.split(end).insertText('A brand new paragraph.', end + 2), () => id)])
        }
        for (const [name, run] of cases) {
          let d: Doc
          try {
            d = run(base)
          } catch {
            continue // a step the schema refuses in Suggesting mode is blocked in the editor, not a G5 case
          }
          if (!d.state.doc.toString().includes('insertion') && !d.state.doc.toString().includes('deletion')) continue
          checked++
          const why = checkTjRecord(d, id)
          if (why) failures.push(`${f.name} ${name} "${w.word}": ${why}`)
        }
      }
    }
    expect(failures).toEqual([])
    expect(checked).toBeGreaterThan(60)
  }, CORPUS_TIMEOUT_MS)
})
