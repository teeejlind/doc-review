// core/splice/apply.ts (P1). applyBlockOps: assemble the new text from L + run splices, verify, widen (CONTRACTS §3.4,
// D36, D37, FINDINGS caveat 1).
//
// Assembly is the S2 oracle's, driven by ops (one op = one S2 flush()):
//  - in-place replacement (covers.length === blocks.length) reuses every original gap;
//  - pure deletion uses sep(gaps[before], gaps[after+1]) (a newly adjacent seam needs a blank line);
//  - insertion / split / merge reuses original gaps where removed blocks were and puts a blank line around new
//    blocks; at EOF the file's trailing text is kept, and an empty file gains a final EOL;
//  - list-merge protection flips the following list's markers on a fresh seam between same-marker lists (D36),
//    recorded in `flips`.
//
// Verification re-classifies the assembled text with the same classifier load() uses and checks it piece by piece:
// every untouched block reloads as exactly itself (same [start, end), so the same hash, and nodeEq nodes; a flipped
// list may differ only in marker bytes), and every run's reloaded nodes equal the classifying parse of what the op
// asked for (`loadRun` of each of its blocks, with L.defs as context). A failure is blamed on the op owning the piece
// or seam involved; when several ops are involved, or none (a distant untouched block changed), each suspect is
// verified on its own and only the ones that fail alone are blamed, so an innocent op never rides the culprit into
// `failed`. Each blamed op climbs the widening ladder (D37):
//   level 1  the op's blocks re-rendered in full (renderNode of their loadRun parse; no 3-way region splice)
//   level 2  plus one untouched neighbour on each side, re-rendered from its L.entries nodes and made part of the op
//   level 3  plus two neighbours on each side
// The intended content never changes across levels (the op's own loadRun nodes plus the neighbours' original
// nodes); only bytes normalize. An op that fails level 3 goes to `failed` and is left out of the text, and the rest is
// re-verified without it, so `text` is always valid. Deterministic: browser and server compute the same result.
//
// Test hooks (never set by production code): setSpliceFaultForTests (G7, D51: matched ops fail every level) and
// setSpliceRenderHookForTests (G7: a patched renderer that can corrupt any piece at any level, which forces each
// ladder level in the unit tests).
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { ApplyBlockOpsResult, BlockInfo, BlockOp } from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import { StoreError } from '../../shared/errors'
import type { Md } from '../md/index'
import { nodeEq } from './eq'
import { classifyText, loadRun, type Entry, type Loaded } from './load'
import { listMarker, renderNode, swapListMarkers } from './render'

type Level = 0 | 1 | 2 | 3
const MAX_LEVEL = CONSTANTS.SPLICE_WIDEN_LEVELS as 3

let spliceFault: ((op: BlockOp) => boolean) | null = null

/**
 * Test-only fault hook (G7, D51). While set, every op it matches fails every ladder level and goes to `failed`.
 * Called by G7 unit tests, by POST /__test/splice-fault (server under MDR_TEST_HOOKS=1, fakeApp) and by
 * window.__mdrDebug.failSplice (page). Production code never sets it.
 */
export function setSpliceFaultForTests(match: ((op: BlockOp) => boolean) | null): void {
  spliceFault = match
}

/** One assembled piece as the render hook sees it: `op` = original op index, `index` = piece index within the op. */
export interface SplicePieceRender { op: number; level: Level; index: number; text: string }
let renderHook: ((p: SplicePieceRender) => string) | null = null

/**
 * Test-only patched renderer (G7). While set, every piece an op contributes passes through it at assembly, after the
 * ladder level's own rendering; what it returns is spliced instead. Verification still compares against the op's
 * intended content, so a corrupting hook makes that level fail. Production code never sets it.
 */
export function setSpliceRenderHookForTests(hook: ((p: SplicePieceRender) => string) | null): void {
  renderHook = hook
}

/** §3.4 BlockOp validation. Any violation → StoreError BAD_REQUEST with `op` = the offending index. */
export function validateBlockOps(blocks: readonly Pick<BlockInfo, 'hash'>[], ops: readonly BlockOp[]): void {
  const n = blocks.length
  const bad = (op: number, why: string): never => {
    throw new StoreError('BAD_REQUEST', `invalid block op ${op}: ${why}`, { op })
  }
  ops.forEach((o, k) => {
    if (!Number.isInteger(o.after) || !Number.isInteger(o.before)) bad(k, 'after/before must be integers')
    if (!(o.after >= -1 && o.after < o.before && o.before <= n)) bad(k, `need -1 <= after < before <= ${n}`)
    if (!Array.isArray(o.covers) || o.before - o.after - 1 !== o.covers.length) bad(k, 'covers.length must equal before - after - 1')
    o.covers.forEach((h, i) => {
      if (h !== blocks[o.after + 1 + i]!.hash) bad(k, `covers[${i}] does not match base block ${o.after + 1 + i}`)
    })
    if (!Array.isArray(o.blocks) || o.blocks.some((b) => typeof b !== 'string')) bad(k, 'blocks must be strings')
    if (k > 0 && ops[k - 1]!.before > o.after) bad(k, 'ops must be sorted by `after` and must not overlap')
  })
}

type ApplyL = Pick<Loaded, 'src' | 'eol' | 'entries' | 'gaps' | 'defs' | 'blocks'>

/** An op as assembled at its current ladder level. */
interface Planned {
  /** Original op index. */
  i: number
  level: Level
  after: number
  before: number
  /** Piece texts (after the level's rendering and the render hook). */
  blocks: string[]
  /** Per piece: the content nodes it must reload as. */
  intended: PMNode[][]
}

interface Piece {
  text: string
  /** Base entry index for an untouched block; null for a piece an op contributed. */
  base: number | null
  /** Original op index for a contributed piece; for a flipped untouched list, the op whose seam caused the flip. */
  op: number | null
  fresh: boolean
  flipped: boolean
  start: number
  end: number
  expected: PMNode[]
}

interface Assembly {
  text: string
  pieces: Piece[]
  /** seamOp[k] = the op that produced the seam before pieces[k] (seamOp[pieces.length] = trailing); null = original. */
  seamOp: Array<number | null>
  flips: ApplyBlockOpsResult['flips']
}

const isContent = (x: PMNode): boolean => !(x.type.name === 'paragraph' && x.content.size === 0)
const contentOf = (nodes: readonly PMNode[]): PMNode[] => nodes.filter(isContent)
const nodesEq = (a: readonly PMNode[], b: readonly PMNode[]): boolean => a.length === b.length && a.every((x, i) => nodeEq(x, b[i]!))

function assemble(md: Md, L: ApplyL, planned: readonly Planned[], o: { flips: boolean }): Assembly {
  const { eol, entries, gaps, src } = L
  const n = entries.length
  const blank = eol + eol
  const hasBlank = (g: string): boolean => /\r?\n[ \t]*\r?\n/.test(g)
  const sep = (...candidates: string[]): string => candidates.find(hasBlank) ?? blank

  const covered = new Set<number>()
  const opBefore = new Map<number, Planned>()
  for (const p of planned) {
    for (let k = p.after + 1; k < p.before; k++) covered.add(k)
    opBefore.set(p.before, p)
  }

  const pieces: Piece[] = []
  const seams: string[] = []
  const fresh: boolean[] = []
  const seamOp: Array<number | null> = []
  const pushSeam = (s: string, f: boolean, op: number | null): void => {
    seams.push(s)
    fresh.push(f)
    seamOp.push(op)
  }
  const pushFresh = (p: Planned, j: number): void => {
    pieces.push({ text: p.blocks[j]!, base: null, op: p.i, fresh: true, flipped: false, start: 0, end: 0, expected: p.intended[j]! })
  }

  let prevKept = -1
  const flush = (nextKept: number): void => {
    const p = opBefore.get(nextKept)
    const removed = nextKept - prevKept - 1
    const pending = p ? p.blocks : []
    const opI = p ? p.i : null
    const atStart = prevKept === -1
    const atEnd = nextKept === n
    if (pending.length === 0) {
      if (removed === 0) pushSeam(gaps[nextKept]!, false, null)
      else pushSeam(atStart ? gaps[0]! : atEnd ? gaps[nextKept]! : sep(gaps[nextKept]!, gaps[prevKept + 1]!), !atStart && !atEnd, opI)
      return
    }
    if (removed === pending.length) {
      // in-place replacement: reuse every original gap exactly
      pending.forEach((_, j) => {
        pushSeam(gaps[prevKept + 1 + j]!, false, opI)
        pushFresh(p!, j)
      })
      pushSeam(gaps[nextKept]!, false, opI)
      return
    }
    // insertion / split / merge: reuse original gaps where removed blocks were, blank lines around new blocks
    pending.forEach((_, j) => {
      if (j === 0) pushSeam(atStart ? gaps[0]! : removed ? sep(gaps[prevKept + 1]!) : blank, !atStart, opI)
      else pushSeam(j < removed ? sep(gaps[prevKept + 1 + j]!) : blank, true, opI)
      pushFresh(p!, j)
    })
    // at the end keep the file's own trailing text; an empty file gains a final EOL
    pushSeam(atEnd ? gaps[nextKept]! || (n === 0 ? eol : '') : sep(gaps[nextKept]!), !atEnd, opI)
  }

  for (let ei = 0; ei < n; ei++) {
    if (covered.has(ei)) continue
    flush(ei)
    const e = entries[ei]!
    // an adopted editor node (G3) is checked as what its bytes parse to, the same check the server makes (QA3 F1)
    pieces.push({ text: src.slice(e.start, e.end), base: ei, op: null, fresh: false, flipped: false, start: 0, end: 0, expected: contentOf(e.parsed ?? e.nodes) })
    prevKept = ei
  }
  flush(n)

  // list-merge protection (D36): two same-marker lists separated only by blank lines are ONE list in CommonMark.
  // Where an edit made two lists adjacent, flip the right one's markers (remark-stringify's bulletOther does the same).
  const flips: ApplyBlockOpsResult['flips'] = []
  if (o.flips) {
    for (let k = 1; k < pieces.length; k++) {
      const left = pieces[k - 1]!
      const right = pieces[k]!
      if (!fresh[k] && !right.fresh && !left.fresh) continue
      const lm = listMarker(md, left.text)
      if (!lm) continue
      const rm = listMarker(md, right.text)
      if (rm && lm.kind === rm.kind && lm.ch === rm.ch) {
        right.text = swapListMarkers(md, right.text)
        right.flipped = true
        const op = right.op ?? left.op ?? seamOp[k] ?? null
        if (right.op === null) right.op = op
        if (op !== null) flips.push({ op, entry: right.base })
      }
    }
  }

  let out = ''
  pieces.forEach((p, k) => {
    out += seams[k]!
    p.start = out.length
    out += p.text
    p.end = out.length
  })
  out += seams[pieces.length] ?? ''
  return { text: out, pieces, seamOp, flips }
}

/** Index of the piece whose [start, end) holds `offset` (empty pieces never hold one), or -1. */
function pieceAt(pieces: readonly Piece[], offset: number): number {
  let lo = 0
  let hi = pieces.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pieces[mid]!.start <= offset) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  // skip back over empty pieces that share the start
  while (ans >= 0 && pieces[ans]!.start === pieces[ans]!.end && pieces[ans]!.start <= offset) ans--
  if (ans < 0) return -1
  const p = pieces[ans]!
  return offset < p.end ? ans : -1
}

/**
 * The outcome of one verification. `bad` = ops a failure belongs to unambiguously (a contributed piece that reloads
 * wrong, or a span swallowed starting in one op's piece with no other op involved). `suspects` = ops involved in a
 * failure that can't be pinned on one of them (a merge across several ops' pieces, an untouched block that changed
 * between two ops); `unowned` = a failure no op touches (an untouched block far from every op changed, e.g. a deleted
 * definition), which makes every op a suspect. applyBlockOps settles suspects by verifying each one on its own.
 */
interface Verdict { bad: Set<number>; suspects: Set<number>; unowned: boolean }

/** Re-classify the assembled text and check it piece by piece (empty verdict = verified). */
function verify(md: Md, a: Assembly): Verdict {
  const R = classifyText(md, a.text)
  const { pieces, seamOp } = a
  const got: Entry[][] = pieces.map(() => [])
  const v: Verdict = { bad: new Set(), suspects: new Set(), unowned: false }
  /** Charge the ops in `ops`: one → bad, several → suspects, none → unowned. */
  const charge = (ops: ReadonlyArray<number | null | undefined>): void => {
    const set = new Set(ops.filter((o): o is number => o !== null && o !== undefined))
    if (set.size === 1) v.bad.add([...set][0]!)
    else if (set.size > 1) set.forEach((o) => v.suspects.add(o))
    else v.unowned = true
  }
  const neighbours = (from: number, to: number): Array<number | null | undefined> =>
    [seamOp[from], seamOp[to + 1], pieces[from - 1]?.op, pieces[to + 1]?.op]
  // pieces inside a swallowing span are judged by the span's charge alone, never one by one
  const swallowed = new Set<number>()

  for (const e of R.entries) {
    const k = pieceAt(pieces, e.start)
    if (k < 0) {
      v.unowned = true
      continue
    }
    if (e.end > pieces[k]!.end) {
      // one reloaded block swallowed a seam: a merge across pieces. Every op owning a piece or a seam in the span
      let last = k
      while (last + 1 < pieces.length && pieces[last + 1]!.start < e.end) last++
      const involved: Array<number | null | undefined> = []
      for (let j = k; j <= last; j++) {
        involved.push(pieces[j]!.op)
        if (j > k) {
          involved.push(seamOp[j])
          swallowed.add(j)
        }
      }
      charge(involved.some((o) => o !== null && o !== undefined) ? involved : neighbours(k, last))
      continue
    }
    got[k]!.push(e)
  }

  pieces.forEach((p, k) => {
    if (swallowed.has(k)) return
    const g = got[k]!
    let ok: boolean
    if (p.base !== null) {
      // an untouched block reloads as exactly itself: same extent (so the same hash, or marker bytes only for a
      // recorded flip) and the same nodes
      ok = g.length === 1 && g[0]!.start === p.start && g[0]!.end === p.end && nodesEq(contentOf(g[0]!.nodes), p.expected)
    } else {
      ok = nodesEq(contentOf(g.flatMap((e) => e.nodes)), p.expected)
    }
    if (ok) return
    if (p.op !== null) v.bad.add(p.op)
    else charge(neighbours(k, k))
  })
  return v
}

const clean = (v: Verdict): boolean => v.bad.size === 0 && v.suspects.size === 0 && !v.unowned

/** Render a list of top-level nodes as one block source in the doc's EOL (raw blocks keep their bytes). */
function renderNodes(md: Md, nodes: readonly PMNode[], eol: string): string {
  return nodes.map((n) => renderNode(md, n, eol as '\n' | '\r\n')).join(eol + eol)
}

/**
 * Apply ops at level 0 with the S2 seam rules and (optionally) list-merge protection, without verification or
 * widening. The corpus G0 checker uses `{ flips: false }` for D36 rule (d); applyBlockOps is the real entry point.
 */
export function assembleOps(md: Md, L: ApplyL, ops: readonly BlockOp[], o: { flips?: boolean } = {}): { text: string; flips: ApplyBlockOpsResult['flips'] } {
  validateBlockOps(L.blocks, ops)
  const planned: Planned[] = ops.map((op, i) => ({ i, level: 0, after: op.after, before: op.before, blocks: [...op.blocks], intended: op.blocks.map(() => []) }))
  const a = assemble(md, L, planned, { flips: o.flips !== false })
  return { text: a.text, flips: a.flips }
}

export function applyBlockOps(md: Md, L: ApplyL, ops: BlockOp[]): ApplyBlockOpsResult {
  validateBlockOps(L.blocks, ops)
  const n = L.entries.length
  const failed = new Set<number>()
  const level = new Map<number, Level>()
  ops.forEach((op, i) => (spliceFault?.(op) ? failed.add(i) : level.set(i, 0)))

  // what each op asks for: per block, the classifying parse with the doc's defs as context (§3.4 verification)
  const intendedCache = new Map<number, PMNode[][]>()
  const intendedOf = (i: number): PMNode[][] => {
    let v = intendedCache.get(i)
    if (!v) intendedCache.set(i, (v = ops[i]!.blocks.map((b) => contentOf(loadRun(md, b, L.defs, L.eol)))))
    return v
  }
  const neighbour = (k: number): { text: string; nodes: PMNode[] } => {
    const e = L.entries[k]!
    const nodes = e.parsed ?? e.nodes
    return { text: renderNodes(md, nodes, L.eol), nodes: contentOf(nodes) }
  }

  const plan = (active: readonly number[]): Planned[] => {
    const out: Planned[] = []
    active.forEach((i, idx) => {
      const op = ops[i]!
      const lv = level.get(i)!
      const intended = intendedOf(i)
      // level >= 1: full re-render from the parse; a block that parses to no content nodes keeps its own bytes
      let blocks = lv >= 1 ? intended.map((nodes, j) => (nodes.length ? renderNodes(md, nodes, L.eol) : op.blocks[j]!)) : [...op.blocks]
      let pieceIntended = [...intended]
      let after = op.after
      let before = op.before
      if (lv >= 2) {
        const want = lv - 1
        // widen only through untouched blocks: a neighbouring op's boundary block may be shared, never consumed
        const leftLimit = idx > 0 ? out[idx - 1]!.before : -1
        const next = active[idx + 1]
        const rightLimit = next !== undefined ? ops[next]!.after : n
        const newAfter = Math.max(after - want, leftLimit)
        const newBefore = Math.min(before + want, rightLimit)
        const left: Array<{ text: string; nodes: PMNode[] }> = []
        for (let k = newAfter + 1; k <= after; k++) left.push(neighbour(k))
        const right: Array<{ text: string; nodes: PMNode[] }> = []
        for (let k = before; k < newBefore; k++) right.push(neighbour(k))
        blocks = [...left.map((x) => x.text), ...blocks, ...right.map((x) => x.text)]
        pieceIntended = [...left.map((x) => x.nodes), ...pieceIntended, ...right.map((x) => x.nodes)]
        after = newAfter
        before = newBefore
      }
      if (renderHook) blocks = blocks.map((text, index) => renderHook!({ op: i, level: lv, index, text }))
      out.push({ i, level: lv, after, before, blocks, intended: pieceIntended })
    })
    return out
  }

  /** An op verified on its own (no other op applied) at its current level. */
  const failsAlone = (i: number): boolean => !clean(verify(md, assemble(md, L, plan([i]), { flips: true })))

  // each round climbs every blamed op one level; levels are bounded, so this terminates in <= 4·ops + 1 rounds
  for (;;) {
    const active = [...level.keys()].sort((a, b) => a - b)
    if (active.length === 0) {
      return { text: L.src, verified: failed.size === 0, widened: [], failed: [...failed].sort((a, b) => a - b), flips: [] }
    }
    const asm = assemble(md, L, plan(active), { flips: true })
    const v: Verdict = asm.text === L.src && active.every((i) => level.get(i) === 0) ? { bad: new Set(), suspects: new Set(), unowned: false } : verify(md, asm)
    const bad = new Set(v.bad)
    if (v.unowned || v.suspects.size) {
      // a failure not pinned on one op: blame only the suspects that fail on their own, so an innocent op never climbs
      // to `failed` with the culprit; a pure interaction (no suspect fails alone) blames them all
      const suspects = v.unowned ? active : [...v.suspects]
      const alone = suspects.filter((i) => !bad.has(i) && failsAlone(i))
      if (alone.length) alone.forEach((i) => bad.add(i))
      else if (!bad.size) suspects.forEach((i) => bad.add(i))
    }
    if (bad.size === 0) {
      const widened: ApplyBlockOpsResult['widened'] = []
      for (const i of active) {
        const lv = level.get(i)!
        if (lv !== 0) widened.push({ op: i, level: lv })
      }
      return { text: asm.text, verified: failed.size === 0, widened, failed: [...failed].sort((a, b) => a - b), flips: asm.flips }
    }
    for (const i of bad) {
      const lv = level.get(i)
      if (lv === undefined) continue
      if (lv >= MAX_LEVEL) {
        level.delete(i)
        failed.add(i)
      } else level.set(i, (lv + 1) as Level)
    }
  }
}
