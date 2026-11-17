// tests/contract/core-api.test.ts (integrator, day 0; CONTRACTS §1.3, §2.2 "Markdown core", §3–§7, §11, §9.6).
//
// Golden cases for the isomorphic core, run against the day-0 stubs now and against P1's final core after M1/M2
// (and P3's rail and P4's digest after their merges). Every case is chosen inside the day-0 floor (§2.4 stub table),
// so it must hold for the stub AND for the real module: exact-tier anchors and quotes, an in-place word edit, a pure
// insertion and a pure deletion, the merge fast path, the fold of the §4.3 example lines, the §4.7 key formula, an
// identity-safe rail layout and an empty pending digest. Anything a stub can't do yet is the producer's own unit suite.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as anchorsOf from '../../core/anchors'
import { blockMap, diffBlocks } from '../../core/blocks'
import { blockHash, docHash } from '../../core/hash'
import { createMd, headlessFingerprint, type Md } from '../../core/md/index'
import { merge3way } from '../../core/merge'
import { buildPending } from '../../core/pending/digest'
import { ptextOf } from '../../core/ptext'
import { findQuoteInPtext, findQuoteInSource } from '../../core/quote'
import { layoutRail } from '../../core/rail/layout'
import { fold, toReviewState } from '../../core/sidecar/fold'
import { cliKey } from '../../core/sidecar/keys'
import { applyBlockOps, setSpliceFaultForTests } from '../../core/splice/apply'
import { contentNodes, docsEquivalent, nodeEq } from '../../core/splice/eq'
import { load, loadRun } from '../../core/splice/load'
import { planSave } from '../../core/splice/plan'
import { assertNoSuggestionMarks, renderNode } from '../../core/splice/render'
import { updateLoaded } from '../../core/splice/update'
import { applyToSource, fromBlock, fromQuote, hunksOf, locate } from '../../core/suggest/record'
import { isStoreError } from '../../shared/errors'
import * as S from '../../shared/schemas'
import type { AgentOp, Anchor, BlockOp, PendingInput, Resolution, SidecarEvent, StoreReviewState } from '../../shared/types'
import { CONSTANTS } from '../../shared/types'
import { CORE_VERSION } from '../../shared/version'

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')

// The golden document: a heading, a paragraph, a two-item list, a paragraph; LF; trailing newline.
const DOC = '# Title\n\nFirst paragraph here.\n\n- one\n- two\n\nLast line.\n'
const PTEXT = 'Title\nFirst paragraph here.\none\ntwo\nLast line.'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  setSpliceFaultForTests(null)
  await md?.destroy()
})

describe('core/md (§3.2)', () => {
  it('createMd() is headless in node and carries the headless fingerprint and CORE_VERSION', async () => {
    expect(md.live).toBe(false)
    expect(md.coreVersion).toBe(CORE_VERSION)
    expect(md.schemaFingerprint).toBe(await headlessFingerprint())
    expect(md.schemaFingerprint).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('core/hash (§0.4, D40)', () => {
  it('docHash hashes the raw bytes, BOM included', () => {
    expect(docHash('abc', false)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(docHash('', false)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(docHash('abc', true)).toBe(sha(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc')])))
    expect(docHash('é\r\n😀', false)).toBe(sha(Buffer.from('é\r\n😀', 'utf8')))
  })

  it('blockHash is the first 16 hex of sha256(utf8(slice))', () => {
    expect(blockHash('First paragraph here.')).toBe(sha('First paragraph here.').slice(0, 16))
  })
})

describe('core/splice load + core/blocks blockMap (§3.3, §3.4)', () => {
  it('maps the golden doc to four blocks with offsets, lines, refs, hashes, ptext ranges and previews', () => {
    const L = load(md, DOC)
    expect(L.src).toBe(DOC)
    expect(L.eol).toBe('\n')
    expect(L.gaps).toEqual(['', '\n\n', '\n\n', '\n\n', '\n'])
    const slice = (s: number, e: number) => DOC.slice(s, e)
    const want = [
      { ref: 'b1', index: 0, kind: 'md', mdType: 'heading', start: 0, end: 7, line: 1, endLine: 1, pStart: 0, pEnd: 5, preview: 'Title' },
      { ref: 'b2', index: 1, kind: 'md', mdType: 'paragraph', start: 9, end: 30, line: 3, endLine: 3, pStart: 6, pEnd: 27, preview: 'First paragraph here.' },
      { ref: 'b3', index: 2, kind: 'md', mdType: 'list', start: 32, end: 43, line: 5, endLine: 6, pStart: 28, pEnd: 35, preview: 'one\ntwo' },
      { ref: 'b4', index: 3, kind: 'md', mdType: 'paragraph', start: 45, end: 55, line: 8, endLine: 8, pStart: 36, pEnd: 46, preview: 'Last line.' },
    ]
    expect(L.blocks).toEqual(want.map((b) => ({ ...b, hash: blockHash(slice(b.start, b.end)), fidelity: 'exact' })))
    expect(blockMap(md, L)).toEqual(L.blocks)
    for (const b of L.blocks) expect(S.BlockInfoSchema.safeParse(b).success).toBe(true)
  })

  it('atom blocks (§3.3): an hr is one block of mdType thematicBreak whose preview is its source', () => {
    const L = load(md, 'a\n\n---\n\nb\n')
    expect(L.blocks.map((b) => [b.mdType, b.preview])).toEqual([['paragraph', 'a'], ['thematicBreak', '---'], ['paragraph', 'b']])
  })

  it('loadRun gives the nodes load() gives for a standalone run', () => {
    const L = load(md, DOC)
    const run = loadRun(md, 'First paragraph here.', L.defs, L.eol)
    expect(run).toHaveLength(1)
    expect(nodeEq(run[0]!, L.entries[1]!.nodes[0]!)).toBe(true)
  })
})

describe('core/ptext (§5.1)', () => {
  it('joins textblocks with \\n, one ￼ per atom block, hardbreak as \\n', () => {
    const L = load(md, DOC)
    const p = ptextOf(L.doc, L)
    expect(p.text).toBe(PTEXT)
    expect(p.blockRanges).toEqual([
      { index: 0, pStart: 0, pEnd: 5 }, { index: 1, pStart: 6, pEnd: 27 }, { index: 2, pStart: 28, pEnd: 35 }, { index: 3, pStart: 36, pEnd: 46 },
    ])
    expect(p.blockAt(10)).toEqual({ index: 1, offsetInBlock: 4 })
    for (const off of [0, 6, 12, 30, 45]) expect(p.toOffset(p.toPos(off, 1))).toBe(off)

    const H = load(md, 'a\n\n---\n\nline one  \nline two\n')
    expect(ptextOf(H.doc, H).text).toBe('a\n￼\nline one\nline two')
  })
})

describe('core/blocks diffBlocks (§3.3)', () => {
  /** Adjacent equal runs merged, so a split LCS run and a single run compare equal. */
  function norm(ops: ReturnType<typeof diffBlocks>) {
    const out: typeof ops = []
    for (const o of ops) {
      const last = out[out.length - 1]
      if (o.op === 'equal' && last?.op === 'equal' && last.a + last.n === o.a && last.b + last.n === o.b) last.n += o.n
      else out.push({ ...o })
    }
    return out
  }
  const h = (s: string) => ({ hash: s })

  it('common prefix, LCS, unmatched runs paired as replace, remainder insert/delete', () => {
    expect(norm(diffBlocks(['A', 'B', 'C', 'D'].map(h), ['A', 'X', 'C', 'D', 'E'].map(h)))).toEqual([
      { op: 'equal', a: 0, b: 0, n: 1 },
      { op: 'replace', a: 1, an: 1, b: 1, bn: 1 },
      { op: 'equal', a: 2, b: 2, n: 2 },
      { op: 'insert', a: 4, an: 0, b: 4, bn: 1 },
    ])
    expect(norm(diffBlocks(['A', 'B', 'C'].map(h), ['A', 'C'].map(h)))).toEqual([
      { op: 'equal', a: 0, b: 0, n: 1 },
      { op: 'delete', a: 1, an: 1, b: 1, bn: 0 },
      { op: 'equal', a: 2, b: 1, n: 1 },
    ])
    expect(norm(diffBlocks(['A', 'B'].map(h), ['A', 'B'].map(h)))).toEqual([{ op: 'equal', a: 0, b: 0, n: 2 }])
    // a split is 1 → 2
    expect(norm(diffBlocks(['A', 'B', 'C'].map(h), ['A', 'X', 'Y', 'C'].map(h)))).toEqual([
      { op: 'equal', a: 0, b: 0, n: 1 },
      { op: 'replace', a: 1, an: 1, b: 1, bn: 2 },
      { op: 'equal', a: 2, b: 3, n: 1 },
    ])
  })
})

describe('core/anchors (§5.2, §5.3)', () => {
  it('createAnchor: canonical short form with prefix, suffix and hint', () => {
    const L = load(md, DOC)
    const p = ptextOf(L.doc, L)
    const a = createAnchorAt(L, p, 12, 21, 3)
    expect(a).toEqual({
      kind: 'text', quote: 'paragraph', prefix: 'Title\nFirst ', suffix: ' here.\none\ntwo\nLast line.',
      hint: { rev: 3, pos: 12, block: 1, blockHash: L.blocks[1]!.hash, offsetInBlock: 6 },
    })
    expect('tail' in a).toBe(false)
    expect(S.TextAnchorSchema.safeParse(a).success).toBe(true)
    // identical inputs give byte-identical anchors (§5.2)
    expect(JSON.stringify(createAnchorAt(L, p, 12, 21, 3))).toBe(JSON.stringify(a))
  })

  it('createAnchor: long form over MAX_QUOTE_CHARS (D45)', () => {
    const para = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ')
    const L = load(md, `${para}\n`)
    const p = ptextOf(L.doc, L)
    const n = p.text.length
    expect(n).toBeGreaterThan(CONSTANTS.MAX_QUOTE_CHARS)
    const a = createAnchorAt(L, p, 0, n, 1)
    expect(a.quote).toBe(p.text.slice(0, CONSTANTS.LONG_QUOTE_EDGE_CHARS))
    expect(a.tail).toBe(p.text.slice(n - CONSTANTS.LONG_QUOTE_EDGE_CHARS))
    expect(a.span).toBe(n)
    expect(a.prefix).toBe('')
    expect(a.suffix).toBe('')
    expect(S.TextAnchorSchema.safeParse(a).success).toBe(true)
    expect(resolve(L, a)).toMatchObject({ state: 'exact', from: 0, to: n })
  })

  it('createBlockAnchor carries kind, mdType and the preview (D35)', () => {
    const L = load(md, 'a\n\n---\n\nb\n')
    expect(anchorsOf.createBlockAnchor(L.blocks, 1, 4)).toEqual({
      kind: 'block', hint: { rev: 4, block: 1, blockHash: L.blocks[1]!.hash, kind: 'md', mdType: 'thematicBreak' }, preview: '---',
    })
  })

  it('resolveAnchor: exact at the hint, moved inside the hinted block, detached when gone, doc for doc anchors', () => {
    const L = load(md, DOC)
    const a = createAnchorAt(L, ptextOf(L.doc, L), 12, 21, 1)
    expect(resolve(L, a)).toMatchObject({ state: 'exact', from: 12, to: 21 })
    // a block inserted above: the hinted hash still finds the block → exact at the new offset
    const above = load(md, DOC.replace('# Title\n\n', '# Title\n\nNew intro.\n\n'))
    expect(resolve(above, a)).toMatchObject({ state: 'exact', from: 23, to: 32 })
    // the block changed around the quote → moved inside the hinted block
    const moved = load(md, DOC.replace('First paragraph', 'First big paragraph'))
    expect(resolve(moved, a)).toMatchObject({ state: 'moved', from: 16, to: 25 })
    // the quote is gone → detached (no fuzzy without o.fuzzy)
    const gone = load(md, DOC.replace('First paragraph here.', 'First sentence here.'))
    expect(resolve(gone, a)).toEqual({ state: 'detached' })
    expect(anchorsOf.resolveAnchor(ptextOf(L.doc, L), L.blocks, { kind: 'doc' })).toEqual({ state: 'doc' })
  })

  it('resolveAnchor: a duplicated quote resolves by context (§5.3 step 3) to the right occurrence, not ambiguous', () => {
    const text = 'The rate is fixed.\n\nNothing here.\n\nAgain the rate is fixed.\n'
    const L = load(md, text)
    const p = ptextOf(L.doc, L)
    const second = p.text.lastIndexOf('rate')
    const a = createAnchorAt(L, p, second, second + 4, 1)
    // the hinted block (index 2) no longer holds the quote and its hash is gone, so steps 1-2 miss; step 3 scores
    // both occurrences by prefix/suffix context and the second one wins strictly
    const changed = load(md, 'Intro one.\n\nIntro two.\n\nNothing.\n\nThe rate is fixed!\n\nAgain the rate is fixed!\n')
    const cp = ptextOf(changed.doc, changed)
    const r = resolve(changed, a)
    expect(r).toMatchObject({ state: 'moved', from: cp.text.lastIndexOf('rate'), to: cp.text.lastIndexOf('rate') + 4 })
    expect(r.ambiguous).toBeUndefined()
  })

  it('resolveAnchor on a block anchor: exact by hash, moved when the index changed', () => {
    const L = load(md, 'a\n\n---\n\nb\n')
    const b = anchorsOf.createBlockAnchor(L.blocks, 1, 1)
    expect(anchorsOf.resolveAnchor(ptextOf(L.doc, L), L.blocks, b)).toMatchObject({ state: 'exact', block: 1 })
    const M = load(md, 'z\n\na\n\n---\n\nb\n')
    expect(anchorsOf.resolveAnchor(ptextOf(M.doc, M), M.blocks, b)).toMatchObject({ state: 'moved', block: 2 })
  })
})

describe('core/quote (§5.5, exact tier)', () => {
  it('finds every exact occurrence in ptext and in source', () => {
    const L = load(md, DOC)
    const p = ptextOf(L.doc, L)
    expect(findQuoteInPtext(md, p, 'paragraph')).toEqual([{ from: 12, to: 21, tier: 'exact' }])
    expect(findQuoteInSource(DOC, 'paragraph')).toEqual([{ start: 15, end: 24, tier: 'exact' }])
    const dup = 'a cat\n\nanother cat\n'
    expect(findQuoteInSource(dup, 'cat').map((h) => [h.start, h.end, h.tier])).toEqual([[2, 5, 'exact'], [15, 18, 'exact']])
  })
})

describe('core/splice plan / apply / update (§3.4)', () => {
  const edited = DOC.replace('paragraph here.', 'paragraph there.')

  it('a one-word edit plans one in-place op and applies byte-exactly; updateLoaded equals load; re-plan is []', () => {
    const L = load(md, DOC)
    const ops = planSave(md, L, load(md, edited).doc)
    expect(ops).toEqual([{ after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: ['First paragraph there.'] }])
    for (const op of ops) expect(S.BlockOpSchema.safeParse(op).success).toBe(true)
    const r = applyBlockOps(md, L, ops)
    expect(r).toEqual({ text: edited, verified: true, widened: [], failed: [], flips: [] })
    expect(S.ApplyBlockOpsResultSchema.safeParse(r).success).toBe(true)
    const L2 = updateLoaded(md, L, r.text, ops)
    const fresh = load(md, edited)
    expect(L2.src).toBe(edited)
    expect(L2.gaps).toEqual(fresh.gaps)
    expect(L2.blocks).toEqual(fresh.blocks)
    expect(docsEquivalent(L2.doc, fresh.doc)).toBe(true)
    expect(planSave(md, L2, L2.doc)).toEqual([])
  })

  it('no edit plans nothing (G0 floor)', () => {
    const L = load(md, DOC)
    expect(planSave(md, L, L.doc)).toEqual([])
    expect(applyBlockOps(md, L, [])).toEqual({ text: DOC, verified: true, widened: [], failed: [], flips: [] })
  })

  it('a pure insertion gets a blank line around the new block; a pure deletion reuses the seam', () => {
    const L = load(md, DOC)
    const ins: BlockOp[] = [{ after: 1, before: 2, covers: [], blocks: ['New para.'] }]
    expect(applyBlockOps(md, L, ins)).toMatchObject({
      text: '# Title\n\nFirst paragraph here.\n\nNew para.\n\n- one\n- two\n\nLast line.\n', verified: true, failed: [],
    })
    const del: BlockOp[] = [{ after: 1, before: 3, covers: [L.blocks[2]!.hash], blocks: [] }]
    expect(applyBlockOps(md, L, del)).toMatchObject({ text: '# Title\n\nFirst paragraph here.\n\nLast line.\n', verified: true, failed: [] })
  })

  it('CRLF docs keep their EOL around a replaced block', () => {
    const crlf = DOC.replace(/\n/g, '\r\n')
    const L = load(md, crlf)
    expect(L.eol).toBe('\r\n')
    const ops: BlockOp[] = [{ after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: ['Changed.'] }]
    expect(applyBlockOps(md, L, ops).text).toBe(crlf.replace('First paragraph here.', 'Changed.'))
  })

  it('invalid ops are BAD_REQUEST (§3.4 validation)', () => {
    const L = load(md, DOC)
    const bad: BlockOp[][] = [
      [{ after: 0, before: 2, covers: ['0000000000000000'], blocks: ['x'] }], // covers mismatch
      [{ after: 0, before: 3, covers: [L.blocks[1]!.hash], blocks: ['x'] }], // count mismatch
      [{ after: 2, before: 1, covers: [], blocks: ['x'] }], // after >= before
      [{ after: 1, before: 2, covers: [], blocks: ['x'] }, { after: 0, before: 1, covers: [], blocks: ['y'] }], // unsorted
    ]
    for (const ops of bad) {
      let err: unknown = null
      try {
        applyBlockOps(md, L, ops)
      } catch (e) {
        err = e
      }
      expect(isStoreError(err) && err.code === 'BAD_REQUEST', JSON.stringify(ops)).toBe(true)
    }
  })

  it('setSpliceFaultForTests sends matching ops to failed and leaves them out of text (G7, D51)', () => {
    const L = load(md, DOC)
    const h = L.blocks[1]!.hash
    const ops: BlockOp[] = [
      { after: 0, before: 2, covers: [h], blocks: ['Faulted.'] },
      { after: 2, before: 4, covers: [L.blocks[3]!.hash], blocks: ['Kept.'] },
    ]
    setSpliceFaultForTests((op) => op.covers.includes(h))
    try {
      const r = applyBlockOps(md, L, ops)
      expect(r.failed).toEqual([0])
      expect(r.verified).toBe(false)
      expect(r.text).toBe(DOC.replace('Last line.', 'Kept.'))
    } finally {
      setSpliceFaultForTests(null)
    }
    expect(applyBlockOps(md, L, ops).failed).toEqual([])
  })

  it('renderNode, assertNoSuggestionMarks, nodeEq and contentNodes behave on plain docs', () => {
    const L = load(md, DOC)
    expect(renderNode(md, L.entries[0]!.nodes[0]!, '\n')).toBe('# Title')
    expect(() => assertNoSuggestionMarks(L.doc)).not.toThrow()
    expect(contentNodes(L.doc)).toHaveLength(4)
    expect(docsEquivalent(L.doc, md.parseDoc(DOC))).toBe(true)
  })
})

describe('core/merge merge3way (§7.3, fast path)', () => {
  it('base hashes equal the current map: ops apply as given, no conflicts, nothing dropped', () => {
    const L = load(md, DOC)
    const ops: BlockOp[] = [{ after: 0, before: 2, covers: [L.blocks[1]!.hash], blocks: ['Mine.'] }]
    const out = merge3way(
      { baseHashes: L.blocks.map((b) => b.hash), current: L, ops, theirsBy: () => ({ by: 'Claude', rev: 2 }) },
      (i) => DOC.slice(L.blocks[i]!.start, L.blocks[i]!.end),
    )
    expect(out).toEqual({ mapped: ops, conflicts: [], dropped: [] })
  })
})

describe('core/suggest/record (§6.2)', () => {
  it('fromQuote: the block run around the exact source span, proposed with the replacement, display hunks', () => {
    const L = load(md, DOC)
    const s = fromQuote(md, L, { quote: 'paragraph', replace: 'section' })
    expect(s.range.start).toBe(1)
    expect(s.range.end).toBe(2)
    expect(s.base).toBe('First paragraph here.')
    expect(s.proposed).toBe('First section here.')
    expect(s.hunks.map((x) => ({ del: x.del, ins: x.ins }))).toEqual([{ del: 'paragraph', ins: 'section' }])
    expect(locate(L, s)).toEqual({ start: 1, end: 2 })
    const r = applyToSource(md, L, s)
    expect(r.verified).toBe(true)
    expect(r.text).toBe(DOC.replace('First paragraph here.', 'First section here.'))
    for (const op of r.ops) expect(S.BlockOpSchema.safeParse(op).success).toBe(true)
  })

  it('fromBlock: base is the block source, proposed the given markdown', () => {
    const L = load(md, DOC)
    const s = fromBlock(md, L, 3, 'Final line.')
    expect([s.range.start, s.range.end, s.base, s.proposed]).toEqual([3, 4, 'Last line.', 'Final line.'])
    expect(applyToSource(md, L, s).text).toBe(DOC.replace('Last line.', 'Final line.'))
  })

  it('hunksOf: dmp over ptext with cleanupSemantic, offsets from `at`', () => {
    expect(hunksOf(md, { base: 'a b c', proposed: 'a x c' }, 100)).toEqual([{ del: 'b', ins: 'x', at: 102 }])
    expect(hunksOf(md, { base: 'same', proposed: 'same' }, 0)).toEqual([])
  })
})

describe('core/sidecar keys (§4.7)', () => {
  /** canonicalJSON: keys sorted at every level, undefined dropped (§4.7). */
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
    }
    return JSON.stringify(v)
  }
  const expected = (rel: string, round: number, op: object) =>
    'cli:' + sha(`${rel}\0${round}\0${canonical(op)}`).slice(0, 32)

  it('cliKey = "cli:" + sha256(relFile \\0 roundSeq \\0 canonicalJSON(op)).slice(0, 32)', () => {
    const reply: AgentOp = { op: 'reply', thread: 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R7', body: 'Yes.' }
    expect(cliKey('PLAN.md', 0, reply)).toBe(expected('PLAN.md', 0, reply))
    const suggest: AgentOp = { op: 'suggest', quote: 'utilize', replace: 'use', reason: 'House rule.' }
    expect(cliKey('docs/a.md', 118, suggest)).toBe(expected('docs/a.md', 118, suggest))
    const nested: AgentOp = { op: 'replace_block', target: { rev: 42, ref: 'b9' }, markdown: 'x' }
    expect(cliKey('a.md', 7, nested)).toBe(expected('a.md', 7, { markdown: 'x', op: 'replace_block', target: { ref: 'b9', rev: 42 } }))
  })

  it('same op, same round → same key; a later round → a new key; key order never matters', () => {
    const a: AgentOp = { op: 'comment', quote: 'x', body: 'y' }
    const b = { body: 'y', quote: 'x', op: 'comment' } as AgentOp
    expect(cliKey('a.md', 3, a)).toBe(cliKey('a.md', 3, b))
    expect(cliKey('a.md', 4, a)).not.toBe(cliKey('a.md', 3, a))
    expect(cliKey('a.md', 3, a)).toMatch(/^cli:[0-9a-f]{32}$/)
  })
})

describe('core/sidecar fold + toReviewState (§4.5) over the §4.3 example lines', () => {
  const md5 = readFileSync(fileURLToPath(new URL('../../CONTRACTS.md', import.meta.url)), 'utf8')
  const fence = /Example lines \(validated by `tests\/contract\/examples\.test\.ts`\):\n\n```jsonl\n([\s\S]*?)\n```/.exec(md5)
  const lines = fence![1]!.split('\n').filter(Boolean).map((l) => JSON.parse(l) as SidecarEvent)
  const resolveAll = (a: Anchor): Resolution => (a.kind === 'doc' ? { state: 'doc' } : { state: 'exact' })

  it('folds threads, the suggestion, keys, the handoff round and the policy', () => {
    const f = fold(lines)
    expect(f.seq).toBe(17)
    expect(f.rev).toBe(9)
    expect([...f.threads.keys()].sort()).toEqual(['t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7', 't_01JAC3K9Q2T7V5X8Y0Z1W2E3R7'])
    expect([...f.suggestions.keys()]).toEqual(['s_01JAC3K9Q2T7V5X8Y0Z1W2E3R9'])
    expect(f.keys.get('tj:op_01JAB3K9Q2T7V5X8Y0Z1W2E3R6')).toEqual([12])
    expect(f.handoffRound).toBe(1)
    expect(f.handoffs.get(16)).toMatchObject({ message: 'Tighten section 2', delivery: 'waiter', round: 1 })
    expect(f.policy).toEqual({ suggestOnly: true })
    expect(f.cursors).toMatchObject({ claudeAck: 0, tjRead: 0, tjReadByThread: {} })
  })

  it('is incremental: fold(b, fold(a)) equals fold(a ++ b)', () => {
    const whole = toReviewState(fold(lines), resolveAll, { file: 'PLAN.md' })
    const split = toReviewState(fold(lines.slice(3), fold(lines.slice(0, 3))), resolveAll, { file: 'PLAN.md' })
    expect(split).toEqual(whole)
  })

  it('toReviewState gives a valid StoreReviewState with both threads and the pending suggestion', () => {
    const r = toReviewState(fold(lines), resolveAll, { file: 'PLAN.md' })
    expect(S.StoreReviewStateSchema.safeParse(r).error?.issues ?? []).toEqual([])
    expect(r).toMatchObject({ ok: true, file: 'PLAN.md', rev: 9, seq: 17, policy: { suggestOnly: true }, undeliveredHandoffs: [16], readOnly: false })
    const comment = r.threads.find((t) => t.id === 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R7')!
    expect(comment).toMatchObject({ kind: 'comment', status: 'open', createdBy: 'TJ', createdSeq: 12 })
    expect(comment.messages.map((m) => [m.id, m.by, m.body])).toEqual([['c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8', 'TJ', 'Is 12% current?']])
    const sug = r.threads.find((t) => t.id === 't_01JAC3K9Q2T7V5X8Y0Z1W2E3R7')!
    expect(sug).toMatchObject({ kind: 'suggestion', status: 'open', createdBy: 'Claude', suggestions: ['s_01JAC3K9Q2T7V5X8Y0Z1W2E3R9'] })
    expect(sug.messages.map((m) => m.body)).toEqual(['House style: plain words.'])
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0]).toMatchObject({
      id: 's_01JAC3K9Q2T7V5X8Y0Z1W2E3R9', by: 'Claude', status: 'pending', base: 'Please utilize the shared tool shed.',
      proposed: 'Please use the shared tool shed.', createdSeq: 13,
    })
  })

  it('applies the suggestion state machine: TJ accept, then reopen', () => {
    const base = { by: 'TJ' as const, at: '2026-10-15T17:10:00.000Z', rev: 9 }
    const more = [
      { ...base, seq: 18, id: 'e_01JAH3K9Q2T7V5X8Y0Z1W2E3R5', type: 'suggestion.accept', suggestion: 's_01JAC3K9Q2T7V5X8Y0Z1W2E3R9', resultRev: 10, rev: 10 },
      { ...base, seq: 19, id: 'e_01JAJ3K9Q2T7V5X8Y0Z1W2E3R5', type: 'suggestion.reopen', suggestion: 's_01JAC3K9Q2T7V5X8Y0Z1W2E3R9', resultRev: 11, rev: 11 },
    ] as SidecarEvent[]
    const accepted = toReviewState(fold(lines.concat(more.slice(0, 1))), resolveAll, { file: 'PLAN.md' })
    expect(accepted.suggestions[0]).toMatchObject({ status: 'accepted', decidedBy: 'TJ', decidedSeq: 18 })
    const reopened = toReviewState(fold(lines.concat(more)), resolveAll, { file: 'PLAN.md' })
    expect(reopened.suggestions[0]!.status).toBe('pending')
  })
})

describe('core/rail layoutRail (§11.1, identity-safe case)', () => {
  it('well-separated cards below minTop stay at their anchors, uncollapsed, in anchor order', () => {
    const out = layoutRail({
      cards: [
        { id: 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R1', anchorY: 100, order: 10, height: 80, collapsedHeight: 24 },
        { id: 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R2', anchorY: 400, order: 50, height: 80, collapsedHeight: 24 },
        { id: 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R3', anchorY: 900, order: 90, height: 120, collapsedHeight: 24 },
      ],
      activeId: null,
      gap: CONSTANTS.RAIL_GAP,
      minTop: 40,
      collapseDisplacement: CONSTANTS.RAIL_COLLAPSE_DISPLACEMENT,
      cluster: { maxAnchorGap: CONSTANTS.RAIL_CLUSTER_MAX_ANCHOR_GAP, minRun: CONSTANTS.RAIL_CLUSTER_MIN_RUN },
    })
    expect(out.overflowAbove).toEqual([])
    expect(out.placements.map((p) => [p.id.slice(-2), p.top, p.collapsed, p.displacement])).toEqual([
      ['R1', 100, false, 0], ['R2', 400, false, 0], ['R3', 900, false, 0],
    ])
    expect(S.RailLayoutOutputSchema.safeParse(out).success).toBe(true)
  })
})

describe('core/pending buildPending (§9.6, empty window)', () => {
  it('an empty log digests to empty: true with zero counts', () => {
    const review: StoreReviewState = {
      ok: true, file: 'a.md', rev: 0, seq: 0, threads: [], suggestions: [], cursors: { claudeAck: 0, tjRead: 0, tjReadByThread: {} },
      undeliveredHandoffs: [], policy: { suggestOnly: false }, warnings: [], readOnly: false,
    }
    const input: PendingInput = {
      file: 'a.md', abs: '/abs/a.md', rev: 0, hash: docHash('', false), via: 'direct', events: [], review, blocks: [],
      runText: () => null,
    }
    const p = buildPending(input)
    expect(S.PendingResultSchema.safeParse(p).error?.issues ?? []).toEqual([])
    expect(p).toMatchObject({ ok: true, via: 'direct', file: 'a.md', empty: true, handoffs: [], threads: [], edits: [], external: [], notices: [] })
    expect(Object.values(p.counts).every((n) => n === 0)).toBe(true)
  })
})

// ------------------------------------------------------------------ helpers

function createAnchorAt(L: ReturnType<typeof load>, p: ReturnType<typeof ptextOf>, from: number, to: number, rev: number) {
  return anchorsOf.createAnchor(p, L.blocks, from, to, rev)
}
function resolve(L: ReturnType<typeof load>, a: Anchor): Resolution {
  return anchorsOf.resolveAnchor(ptextOf(L.doc, L), L.blocks, a)
}
