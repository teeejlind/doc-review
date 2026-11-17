// core/rail/layout.ts (P3, pure). The rail layout engine (CONTRACTS §11.1, invariants §11.2).
//
// Every input and output is in scroll-container CONTENT coordinates (§12.0.3), so a layout never depends on the
// current scroll position and never has to rerun on scroll. No DOM, no clock, no previous-frame input: the same
// input (in any card order) always yields the same output (I6).
//
// Algorithm, exactly two passes (§11.1):
//   1. Sort by (anchorY, order, id); a = the active index, if any.
//   2. Clusters from anchors alone: maximal runs of consecutive cards whose anchor gaps are <= cluster.maxAnchorGap,
//      of length >= cluster.minRun. C0 = cluster members except the active card and pinExpanded cards.
//   3. Pass 1 with h_i = collapsed(i) ? collapsedHeight : height. Active present: top_a = max(anchorY_a, minTop),
//      then upward top_i = min(anchorY_i, top_{i+1} - gap - h_i) and downward top_i = max(anchorY_i, top_{i-1} +
//      h_{i-1} + gap). No active: forward from minTop.
//   4. C1 = C0 + every card (not active, not pinned) displaced more than collapseDisplacement in pass 1.
//      Clarification (contract-changes/P3.md, 2026-10-15): if pass 1 leaves any card above the active card with
//      top < minTop, C1 also takes every non-pinned card above the active card. Without it, a full-height card
//      displaced by less than collapseDisplacement can push its neighbours under the header while collapsing it
//      would have let them all fit, which breaks I8.
//   5. Pass 2: step 3 again with C1 heights.
//   6. Overflow: k = the largest index above a with top_k < minTop; cards 0..k leave `placements` for
//      `overflowAbove` (one "+N above" chip at minTop). The active card never moves to make room.
//
// Heights only shrink from pass 1 to pass 2, so every card's |displacement| also only shrinks: after pass 2 an
// expanded, unpinned, inactive card is never displaced by more than collapseDisplacement.
//
// A card whose full height is below its collapsedHeight keeps the smaller value when collapsed (a one-line card
// is its own preview); with that, collapsing never makes a card taller.
import type { LayoutRail, RailCardInput, RailLayoutInput, RailLayoutOutput, RailPlacement } from '../../shared/types'

/** The §11.1 sort key: (anchorY, order, id), ids compared by UTF-16 code units. */
export function compareCards(a: RailCardInput, b: RailCardInput): number {
  return a.anchorY - b.anchorY || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Effective height of card `c` when collapsed. */
export function collapsedHeightOf(c: RailCardInput): number {
  return Math.min(c.collapsedHeight, c.height)
}

/** Indices (into the sorted list) of every card that belongs to an anchor cluster (§11.1 step 2). */
export function clusterMembers(sorted: readonly RailCardInput[], cluster: RailLayoutInput['cluster']): Set<number> {
  const members = new Set<number>()
  let start = 0
  for (let i = 1; i <= sorted.length; i++) {
    const breaks = i === sorted.length || sorted[i]!.anchorY - sorted[i - 1]!.anchorY > cluster.maxAnchorGap
    if (!breaks) continue
    if (i - start >= cluster.minRun) for (let j = start; j < i; j++) members.add(j)
    start = i
  }
  return members
}

/**
 * One pass of §11.1 step 3. `h[i]` is the effective height of sorted card i; `a` the active index or -1.
 * Returns the top of every card (including any that will later overflow).
 */
export function placePass(sorted: readonly RailCardInput[], h: readonly number[], a: number, gap: number, minTop: number): number[] {
  const n = sorted.length
  const top = new Array<number>(n)
  if (n === 0) return top
  if (a >= 0) {
    top[a] = Math.max(sorted[a]!.anchorY, minTop)
    for (let i = a - 1; i >= 0; i--) top[i] = Math.min(sorted[i]!.anchorY, top[i + 1]! - gap - h[i]!)
    for (let i = a + 1; i < n; i++) top[i] = Math.max(sorted[i]!.anchorY, top[i - 1]! + h[i - 1]! + gap)
  } else {
    top[0] = Math.max(sorted[0]!.anchorY, minTop)
    for (let i = 1; i < n; i++) top[i] = Math.max(sorted[i]!.anchorY, top[i - 1]! + h[i - 1]! + gap)
  }
  return top
}

export const layoutRail: LayoutRail = (input: RailLayoutInput): RailLayoutOutput => {
  const { gap, minTop, collapseDisplacement } = input
  const sorted = [...input.cards].sort(compareCards)
  const n = sorted.length
  const a = input.activeId === null ? -1 : sorted.findIndex((c) => c.id === input.activeId)
  const collapsible = (i: number): boolean => i !== a && sorted[i]!.pinExpanded !== true

  // Step 2: C0 from anchors alone.
  const collapsed = new Set<number>()
  for (const i of clusterMembers(sorted, input.cluster)) if (collapsible(i)) collapsed.add(i)

  const heights = (): number[] => sorted.map((c, i) => (collapsed.has(i) ? collapsedHeightOf(c) : c.height))

  // Step 3: pass 1.
  const top1 = placePass(sorted, heights(), a, gap, minTop)

  // Step 4: C1 (C0 plus displaced cards; plus every collapsible card above the active one if any overflows).
  for (let i = 0; i < n; i++) {
    if (collapsible(i) && Math.abs(top1[i]! - sorted[i]!.anchorY) > collapseDisplacement) collapsed.add(i)
  }
  if (a > 0 && top1[0]! < minTop) for (let i = 0; i < a; i++) if (collapsible(i)) collapsed.add(i)

  // Step 5: pass 2.
  const h2 = heights()
  const top2 = placePass(sorted, h2, a, gap, minTop)

  // Step 6: overflow above the active card.
  let k = -1
  for (let i = a - 1; i >= 0; i--) {
    if (top2[i]! < minTop) {
      k = i
      break
    }
  }

  const overflowAbove: string[] = []
  const placements: RailPlacement[] = []
  let height = 0
  for (let i = 0; i < n; i++) {
    const c = sorted[i]!
    if (i <= k) {
      overflowAbove.push(c.id)
      continue
    }
    const t = top2[i]!
    placements.push({ id: c.id, top: t, height: h2[i]!, collapsed: collapsed.has(i), displacement: t - c.anchorY })
    height = Math.max(height, t + h2[i]!)
  }
  return { placements, overflowAbove, height }
}
