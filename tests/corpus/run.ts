// tests/corpus/run.ts (P1; CONTRACTS §1.3 "corpus", §3.4 corpus gates, §0.2 S2-e). `npm run corpus` runs it with tsx,
// then P2's G5 suite.
//
// Corpus: tests/fixtures/docs/ and tests/corpus/fixtures/synthetic/ (committed) plus tests/corpus/fixtures/real/
// (gitignored; `python3 scripts/build-corpus.py` copies it read-only from the workspace). Without the real set it
// prints `real: skipped (run scripts/build-corpus.py)`; the QA gate needs it.
//
// Gates (all 100%):
//   G0       no-op byte-identical (planSave = [], applyBlockOps verified, same bytes); every S2 edit class plus the
//            sweep block-scoped under the D36 rule, with list-flip hits in their own column; table delimiter rows
//            kept; a frontmatter field edit changes exactly one line; content round trip; re-save no-op
//   G0-flip  across the delete suite, recorded flips == same-marker adjacencies the deletions created
//            (the synthetic positive/negative cases are tests/unit/core/splice/list-merge-flip.test.ts)
//   G1       applyBlockOps(planSave) === oracleSave over the edit suite and the sweep (where the oracle verifies)
//   G2       updateLoaded(L, text, ops) equals load(text) on every edit; < 5 ms median for a one-block op on 10k words
//   G3       planSave(updateLoaded(..., liveNodes), sameDoc) === []
//   G4, G6   ptext and block-map parity: one jsdom boot's load() vs a second boot's load() with fidelityHints
//   G7       across the corpus and sweep, nothing widened and nothing failed (forced levels: splice/ladder.test.ts)
//   S2-b     the S2 suggest-changes flow on the split pipeline, every check on every applicable file
// Budgets (S2-e) are measured first, so the first parse is cold; record them in tests/corpus/BUDGETS.md.
// Env: CORPUS_SWEEP_MAX (default 25 blocks per file per sweep kind, S2's setting). Report: test-results/corpus-report.json.
// Exit 0 when every gate is green, 1 otherwise.
import '../../node/dom'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EditorState } from '@milkdown/kit/prose/state'
import type { BlockHash, Fidelity } from '../../shared/types'
import { createMd, type Md } from '../../core/md/index'
import { ptextOf } from '../../core/ptext'
import { applyBlockOps } from '../../core/splice/apply'
import { load } from '../../core/splice/load'
import { planSave } from '../../core/splice/plan'
import { updateLoaded } from '../../core/splice/update'
import {
  createdAdjacency, delimiterRowsKept, evaluate, findWord, frontmatterEdit, mangle, multiEdit, onlyLineChanged,
  structuralEdit, suggestFlow, sweepEdits, wordEdit, type Edit, type EvalResult, type MultiKind, type Structural,
  type SweepKind, type Target,
} from './harness'
import { oracleSave } from './oracle-save'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCES = [
  { kind: 'synthetic', dir: join(HERE, '..', 'fixtures', 'docs') },
  { kind: 'synthetic', dir: join(HERE, 'fixtures', 'synthetic') },
  { kind: 'real', dir: join(HERE, 'fixtures', 'real') },
] as const
const REPORT = join(HERE, '..', '..', 'test-results', 'corpus-report.json')
const SWEEP_MAX = Number(process.env.CORPUS_SWEEP_MAX ?? 25)

interface CorpusFile { name: string; kind: 'synthetic' | 'real'; text: string }

function readCorpus(): { files: CorpusFile[]; realSkipped: boolean; unreadable: string[] } {
  const files: CorpusFile[] = []
  const unreadable: string[] = []
  let realSkipped = true
  for (const s of SOURCES) {
    if (!existsSync(s.dir)) continue
    for (const name of readdirSync(s.dir).filter((n) => /\.(md|markdown)$/.test(n)).sort()) {
      const raw = readFileSync(join(s.dir, name))
      const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      const body = raw.subarray(bom ? 3 : 0)
      try {
        // §3.1: fatal UTF-8 decode plus the re-encode guard; load() receives BOM-stripped text (S2-a)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
        if (!Buffer.from(text, 'utf8').equals(body)) throw new Error('re-encode mismatch')
        files.push({ name, kind: s.kind, text })
        if (s.kind === 'real') realSkipped = false
      } catch (e) {
        unreadable.push(`${name}: NOT_UTF8 (${(e as Error).message})`)
      }
    }
  }
  return { files, realSkipped, unreadable }
}

/** A deterministic ~10k-word doc (headings, paragraphs, lists, a table) for the G2 timing, independent of the real set. */
function tenKWords(): string {
  const words = ['member', 'rate', 'private', 'credit', 'marketplace', 'investor', 'returns', 'note', 'deal', 'borrower', 'term', 'yield']
  const w = (i: number): string => words[(i * 7 + 3) % words.length]!
  const out: string[] = ['---', 'title: perf', '---', '']
  let n = 0
  for (let s = 0; n < 10_000; s++) {
    out.push(`## Section ${s + 1}`, '')
    for (let p = 0; p < 6; p++) {
      const len = 40 + ((s * 13 + p * 7) % 30)
      out.push(Array.from({ length: len }, (_, i) => w(n + i)).join(' ') + '.', '')
      n += len
    }
    out.push(`- first ${w(s)} item`, `- second ${w(s + 1)} item`, `- third ${w(s + 2)} item`, '')
    n += 9
    if (s % 5 === 0) out.push('| a | b |', '|---|:-:|', `| ${w(s)} | ${w(s + 3)} |`, '')
  }
  return out.join('\n')
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : NaN
}
const ms = (x: number): string => `${x.toFixed(1)} ms`

function measureBudgets(md: Md, files: CorpusFile[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const big = [...files].sort((a, b) => b.text.length - a.text.length)[0]
  if (big) {
    let t = performance.now()
    const L = load(md, big.text)
    out.loadCold = { ms: performance.now() - t, file: big.name, bytes: Buffer.byteLength(big.text), words: big.text.split(/\s+/).length }
    const warm: number[] = []
    for (let i = 0; i < 5; i++) {
      t = performance.now()
      load(md, big.text)
      warm.push(performance.now() - t)
    }
    out.loadWarm = { ms: median(warm), max: Math.max(...warm) }
    // edit-save incl. verification: planSave + applyBlockOps of one-word edits in distinct blocks (each block uncached)
    const saves: number[] = []
    for (const e of sweepEdits(md, L, 5, 'replace-word')) {
      t = performance.now()
      applyBlockOps(md, L, planSave(md, L, e.doc))
      saves.push(performance.now() - t)
    }
    out.editSave = { ms: median(saves), max: Math.max(...saves), n: saves.length }
  }
  // G2 timing: a one-block op on a 10k-word doc
  const timeUpdate = (text: string): { ms: number; max: number; words: number } | null => {
    const L = load(md, text)
    const hit = findWord(L.doc, 'paragraph')
    if (!hit) return null
    const doc = EditorState.create({ schema: md.schema, doc: L.doc }).tr.insertText(mangle(hit.word), hit.from, hit.to).doc
    const ops = planSave(md, L, doc)
    const r = applyBlockOps(md, L, ops)
    const xs: number[] = []
    for (let i = 0; i < 25; i++) {
      const t = performance.now()
      updateLoaded(md, L, r.text, ops)
      xs.push(performance.now() - t)
    }
    return { ms: median(xs), max: Math.max(...xs), words: text.split(/\s+/).length }
  }
  // node/jsdom proxy for the browser row (the Chromium number is P2/P3's, on P3's perf fixture)
  const ten = tenKWords()
  const t10 = performance.now()
  load(md, ten)
  out.load10kNode = { ms: performance.now() - t10, words: ten.split(/\s+/).length }
  out.updateLoaded10k = timeUpdate(ten)
  const real10k = files.filter((f) => f.kind === 'real').map((f) => ({ f, d: Math.abs(f.text.split(/\s+/).length - 10_000) })).sort((a, b) => a.d - b.d)[0]
  if (real10k) out.updateLoadedReal10k = { ...timeUpdate(real10k.f.text), file: real10k.f.name }
  return out
}

// ------------------------------------------------------------------ run

const tBoot = performance.now()
const md = await createMd()
const bootMs = performance.now() - tBoot
// G4 / G6 compare two boots: the second classifies with fidelityHints taken from the first
const md2 = await createMd()
const t0 = Date.now()
const { files, realSkipped, unreadable } = readCorpus()
const budgets = measureBudgets(md, files)

const TARGETS: Target[] = ['paragraph', 'list-paragraph', 'heading', 'blockquote-paragraph', 'table-cell']
const STRUCT: Structural[] = ['insert-paragraph', 'delete-block', 'split-paragraph']
const MULTI: MultiKind[] = ['join-paragraphs', 'move-block', 'two-blocks']
const SWEEP: SweepKind[] = ['replace-word', 'delete-word', 'bold-word']

interface Agg {
  n: number; scoped: number; flipHits: number; content: number; resave: number; oneLine: number
  g1n: number; g1: number; oracleUnverified: number; g2: number; g3: number; g7: number
  methods: Record<string, number>; fails: string[]
}
const agg: Record<string, Agg> = {}
const bump = (key: string, file: string, r: EvalResult): void => {
  const a = (agg[key] ??= { n: 0, scoped: 0, flipHits: 0, content: 0, resave: 0, oneLine: 0, g1n: 0, g1: 0, oracleUnverified: 0, g2: 0, g3: 0, g7: 0, methods: {}, fails: [] })
  a.n++
  if (r.scoped) a.scoped++
  a.flipHits += r.flipHits
  if (r.contentOk) a.content++
  if (r.resaveOk) a.resave++
  if (r.linesTouched <= 1) a.oneLine++
  if (r.g1 === null) a.oracleUnverified++
  else {
    a.g1n++
    if (r.g1) a.g1++
  }
  if (r.g2) a.g2++
  if (r.g3) a.g3++
  if (r.g7) a.g7++
  a.methods[r.method] = (a.methods[r.method] ?? 0) + 1
  if (r.detail) a.fails.push(`${file}${r.topType ? ` (${r.topType})` : ''}: ${r.detail}`)
}

const fileGates = { noop: { n: 0, ok: 0, fails: [] as string[] }, g4: { n: 0, ok: 0, fails: [] as string[] }, g6: { n: 0, ok: 0, fails: [] as string[] } }
const extra = { tableDelim: { n: 0, ok: 0, fails: [] as string[] }, fmLine: { n: 0, ok: 0, fails: [] as string[] } }
const flipCount = { cases: 0, mismatches: [] as string[], created: 0, recorded: 0 }
const sugg: Record<string, number> = {}
let suggN = 0
const suggFails: string[] = []
const fidelity: Record<string, Record<string, number>> = {}
const threw: string[] = []
const rows: Array<Record<string, unknown>> = []

for (const f of files) {
  const row: Record<string, unknown> = { file: f.name, kind: f.kind, bytes: Buffer.byteLength(f.text) }
  try {
    const L = load(md, f.text)
    for (const e of L.entries) (fidelity[e.mdType] ??= {})[e.fidelity] = ((fidelity[e.mdType] ??= {})[e.fidelity] ?? 0) + 1

    // G0 no-op (and the oracle agrees)
    const noop = planSave(md, L, L.doc)
    const r0 = applyBlockOps(md, L, noop)
    const noopOk = noop.length === 0 && r0.text === f.text && r0.verified && oracleSave(md, L, L.doc).text === f.text
    fileGates.noop.n++
    if (noopOk) fileGates.noop.ok++
    else fileGates.noop.fails.push(`${f.name}: ${noop.length ? `${noop.length} op(s) planned for a no-op` : r0.text !== f.text ? 'bytes changed' : 'not verified'}`)
    row.noop = noopOk

    // G4 / G6: a second boot classifies with fidelityHints taken from the first
    const hints = new Map<BlockHash, Fidelity>(L.blocks.map((b) => [b.hash, b.fidelity]))
    const H = load(md2, f.text, { fidelityHints: hints })
    const key = (x: typeof L): string => JSON.stringify(x.blocks.map((b) => [b.hash, b.start, b.end, b.fidelity]))
    fileGates.g6.n++
    if (key(L) === key(H)) fileGates.g6.ok++
    else fileGates.g6.fails.push(f.name)
    const p1 = ptextOf(L.doc, L)
    const p2 = ptextOf(H.doc, H)
    fileGates.g4.n++
    if (p1.text === p2.text && JSON.stringify(p1.blockRanges) === JSON.stringify(p2.blockRanges)) fileGates.g4.ok++
    else fileGates.g4.fails.push(f.name)

    // the S2 edit suite
    for (const t of TARGETS) {
      const e = wordEdit(md, L, t)
      if (!e) continue
      const r = evaluate(md, L, e)
      bump(t, f.name, r)
      if (t === 'table-cell') {
        extra.tableDelim.n++
        if (delimiterRowsKept(f.text, r.text)) extra.tableDelim.ok++
        else extra.tableDelim.fails.push(f.name)
      }
    }
    const fe = frontmatterEdit(md, L)
    if (fe) {
      const r = evaluate(md, L, fe)
      bump('frontmatter-field', f.name, r)
      extra.fmLine.n++
      if (onlyLineChanged(f.text, r.text, fe.fmLine)) extra.fmLine.ok++
      else extra.fmLine.fails.push(f.name)
    }
    for (const s of STRUCT) {
      const e = structuralEdit(md, L, s)
      if (!e) continue
      const r = evaluate(md, L, e)
      bump(s, f.name, r)
      if (s === 'delete-block') {
        const created = createdAdjacency(md, L, e.entry)
        flipCount.cases++
        flipCount.created += created
        flipCount.recorded += r.flips
        if (created !== r.flips) flipCount.mismatches.push(`${f.name}: created ${created}, recorded ${r.flips}`)
      }
    }
    for (const m of MULTI) {
      const e = multiEdit(md, L, m)
      if (e) bump(m, f.name, evaluate(md, L, e))
    }
    for (const k of SWEEP) {
      for (const e of sweepEdits(md, L, SWEEP_MAX, k) as Edit[]) {
        const r = evaluate(md, L, e)
        bump(`sweep:${k}`, f.name, r)
      }
    }

    // S2-b: the suggest-changes flow on the split pipeline
    const sr = suggestFlow(md, L)
    if (sr.applicable) {
      suggN++
      const bad: string[] = []
      for (const [k, v] of Object.entries(sr)) {
        if (typeof v !== 'boolean' || k === 'applicable') continue
        if (v) sugg[k] = (sugg[k] ?? 0) + 1
        else bad.push(k)
      }
      if (bad.length) suggFails.push(`${f.name}: ${bad.join(',')} ${sr.detail ?? ''}`)
    }
  } catch (e) {
    threw.push(`${f.name}: ${(e as Error).stack ?? (e as Error).message}`)
    row.error = (e as Error).message
  }
  rows.push(row)
}
await md.destroy()
await md2.destroy()

// ------------------------------------------------------------------ report

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a')
const real = files.filter((f) => f.kind === 'real').length
console.log(`corpus: ${files.length} files (${files.length - real} synthetic, ${real} real), ${((Date.now() - t0) / 1000).toFixed(1)}s, boot ${ms(bootMs)}`)
if (realSkipped) console.log('real: skipped (run scripts/build-corpus.py)')
for (const u of unreadable) console.log(`  unreadable ${u}`)
for (const t of threw) console.log(`  THREW ${t}`)

let failed = unreadable.length > 0 || threw.length > 0
const gate = (ok: boolean, label: string, detail: string, fails: string[] = []): void => {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(8)} ${detail}`)
  for (const x of fails.slice(0, 8)) console.log(`       ${x}`)
  if (fails.length > 8) console.log(`       … ${fails.length - 8} more`)
}

const { noop, g4, g6 } = fileGates
gate(noop.ok === noop.n, 'G0', `no-op byte-identical ${noop.ok}/${noop.n}`, noop.fails)

console.log('\nedits: n | G0 scoped | flip hits | content | re-save | G1 (=oracle / compared, oracle-unverified) | G2 | G3 | G7 | <=1 line | method')
let tot = { n: 0, scoped: 0, flipHits: 0, content: 0, resave: 0, g1n: 0, g1: 0, ou: 0, g2: 0, g3: 0, g7: 0 }
for (const [k, a] of Object.entries(agg)) {
  console.log(
    `  ${k.padEnd(24)} n=${String(a.n).padStart(5)} scoped ${pct(a.scoped, a.n).padStart(6)} flips ${String(a.flipHits).padStart(2)} ` +
      `content ${pct(a.content, a.n).padStart(6)} resave ${pct(a.resave, a.n).padStart(6)} G1 ${a.g1}/${a.g1n}${a.oracleUnverified ? ` (+${a.oracleUnverified} oracle-unverified)` : ''} ` +
      `G2 ${pct(a.g2, a.n)} G3 ${pct(a.g3, a.n)} G7 ${pct(a.g7, a.n)} <=1line ${pct(a.oneLine, a.n)} ${JSON.stringify(a.methods)}`,
  )
  for (const x of a.fails.slice(0, 5)) console.log(`        FAIL ${x}`)
  if (a.fails.length > 5) console.log(`        … ${a.fails.length - 5} more`)
  tot = {
    n: tot.n + a.n, scoped: tot.scoped + a.scoped, flipHits: tot.flipHits + a.flipHits, content: tot.content + a.content, resave: tot.resave + a.resave,
    g1n: tot.g1n + a.g1n, g1: tot.g1 + a.g1, ou: tot.ou + a.oracleUnverified, g2: tot.g2 + a.g2, g3: tot.g3 + a.g3, g7: tot.g7 + a.g7,
  }
}
console.log('')
const allFails = Object.values(agg).flatMap((a) => a.fails)
gate(tot.scoped === tot.n && tot.content === tot.n && tot.resave === tot.n, 'G0', `edits block-scoped ${tot.scoped}/${tot.n} (flip hits ${tot.flipHits}), content ${tot.content}/${tot.n}, re-save ${tot.resave}/${tot.n}`)
gate(extra.tableDelim.ok === extra.tableDelim.n, 'G0', `table delimiter rows kept ${extra.tableDelim.ok}/${extra.tableDelim.n}`, extra.tableDelim.fails)
gate(extra.fmLine.ok === extra.fmLine.n, 'G0', `frontmatter field edit changes one line ${extra.fmLine.ok}/${extra.fmLine.n}`, extra.fmLine.fails)
gate(flipCount.mismatches.length === 0, 'G0-flip', `delete suite: ${flipCount.recorded} flips recorded = ${flipCount.created} same-marker adjacencies created (${flipCount.cases} deletions)`, flipCount.mismatches)
gate(tot.g1 === tot.g1n, 'G1', `applyBlockOps(planSave) === oracleSave ${tot.g1}/${tot.g1n}${tot.ou ? ` (${tot.ou} where the oracle did not verify)` : ''}`)
const up = budgets.updateLoaded10k as { ms: number; max: number; words: number } | null
gate(tot.g2 === tot.n && up !== null && up.ms < 5, 'G2', `updateLoaded equals load ${tot.g2}/${tot.n}; one-block op on ${up?.words ?? '?'} words: median ${up ? ms(up.ms) : 'n/a'} (max ${up ? ms(up.max) : 'n/a'}), budget < 5 ms`)
gate(tot.g3 === tot.n, 'G3', `re-plan after updateLoaded is [] ${tot.g3}/${tot.n}`)
gate(g4.ok === g4.n, 'G4', `ptext parity with fidelityHints ${g4.ok}/${g4.n}`, g4.fails)
gate(g6.ok === g6.n, 'G6', `block-map parity with fidelityHints ${g6.ok}/${g6.n}`, g6.fails)
const widened = Object.values(agg).reduce((s, a) => s + (a.n - a.g7), 0)
gate(widened === 0, 'G7', `edits with widened or failed ops: ${widened} (expected 0; forced levels: tests/unit/core/splice/ladder.test.ts)`)
const suggOk = suggFails.length === 0
gate(suggOk, 'S2-b', `suggest-changes flow on the split pipeline over ${suggN} files: ${Object.entries(sugg).map(([k, v]) => `${k} ${v}/${suggN}`).join(', ')}`, suggFails)

console.log('\nfidelity by mdType:')
for (const [t, v] of Object.entries(fidelity).sort()) console.log(`    ${t.padEnd(20)} ${JSON.stringify(v)}`)
console.log('\nbudgets (S2-e; record in tests/corpus/BUDGETS.md):')
for (const [k, v] of Object.entries(budgets)) console.log(`    ${k.padEnd(20)} ${JSON.stringify(v, (_k, x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x))}`)

mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, JSON.stringify({ files: rows, agg, fileGates, extra, flipCount, sugg, suggN, suggFails, fidelity, budgets, bootMs, failures: allFails }, null, 2))
console.log(`\nreport: ${REPORT}`)
process.exit(failed ? 1 : 0)
