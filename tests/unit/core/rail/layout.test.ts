// tests/unit/core/rail/layout.test.ts (P3; CONTRACTS §11.1, §11.2).
//
// fast-check property suite for layoutRail: I1–I8, the named 10-cards-in-300px-at-the-top case, plus the
// properties that follow from the algorithm (every card accounted for exactly once, displacement = top − anchorY,
// expanded inactive cards are never displaced past collapseDisplacement, cluster members collapse).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CONSTANTS } from '../../../../shared/constants'
import type { RailCardInput, RailLayoutInput, RailLayoutOutput, ThreadId } from '../../../../shared/types'
import { collapsedHeightOf, compareCards, layoutRail } from '../../../../core/rail/layout'

const EPS = 1e-6
const RUNS = { numRuns: 400 }

// ------------------------------------------------------------------ generators

const tid = (i: number): ThreadId => `t_${String(i).padStart(26, '0')}`

/** Anchors bunch up (several cards per paragraph, clusters) as well as spread out. */
const anchorArb = fc.oneof(
  fc.integer({ min: 0, max: 400 }),
  fc.integer({ min: 0, max: 4000 }),
  fc.double({ min: 0, max: 3000, noNaN: true, noDefaultInfinity: true }),
)

const cardArb = (i: number): fc.Arbitrary<RailCardInput> =>
  fc
    .record({
      anchorY: anchorArb,
      order: fc.integer({ min: 0, max: 50 }),
      height: fc.oneof(fc.integer({ min: 24, max: 600 }), fc.double({ min: 1, max: 400, noNaN: true, noDefaultInfinity: true })),
      collapsedHeight: fc.integer({ min: 16, max: 64 }),
      pinExpanded: fc.option(fc.boolean(), { nil: undefined, freq: 3 }),
    })
    .map((r) => {
      const c: RailCardInput = { id: tid(i), anchorY: r.anchorY, order: r.order, height: r.height, collapsedHeight: r.collapsedHeight }
      if (r.pinExpanded !== undefined) c.pinExpanded = r.pinExpanded
      return c
    })

const cardsArb = (min = 0, max = 24): fc.Arbitrary<RailCardInput[]> =>
  fc.integer({ min, max }).chain((n) => (n === 0 ? fc.constant([]) : fc.tuple(...Array.from({ length: n }, (_, i) => cardArb(i)))))

const paramsArb = fc.record({
  gap: fc.integer({ min: 0, max: 24 }),
  minTop: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 400 })),
  collapseDisplacement: fc.oneof(fc.constant(CONSTANTS.RAIL_COLLAPSE_DISPLACEMENT), fc.integer({ min: 0, max: 400 })),
  maxAnchorGap: fc.oneof(fc.constant(CONSTANTS.RAIL_CLUSTER_MAX_ANCHOR_GAP), fc.integer({ min: 0, max: 200 })),
  minRun: fc.oneof(fc.constant(CONSTANTS.RAIL_CLUSTER_MIN_RUN), fc.integer({ min: 1, max: 6 })),
})

const inputArb = (o: { active?: 'any' | 'always' | 'never'; minCards?: number } = {}): fc.Arbitrary<RailLayoutInput> =>
  fc
    .tuple(cardsArb(o.minCards ?? 0), paramsArb, fc.nat(), fc.boolean())
    .map(([cards, p, pick, noActive]) => {
      const wantActive = o.active === 'always' ? cards.length > 0 : o.active === 'never' ? false : !noActive && cards.length > 0
      return {
        cards,
        activeId: wantActive ? cards[pick % cards.length]!.id : null,
        gap: p.gap,
        minTop: p.minTop,
        collapseDisplacement: p.collapseDisplacement,
        cluster: { maxAnchorGap: p.maxAnchorGap, minRun: p.minRun },
      }
    })

// ------------------------------------------------------------------ helpers

const sortedOf = (input: RailLayoutInput): RailCardInput[] => [...input.cards].sort(compareCards)
const activeIndex = (input: RailLayoutInput): number => (input.activeId === null ? -1 : sortedOf(input).findIndex((c) => c.id === input.activeId))
const byId = (out: RailLayoutOutput) => new Map(out.placements.map((p) => [p.id, p]))

/** I8 oracle: can every card above the active one sit at or below minTop with every unpinned one collapsed? */
function fitsWhenCollapsed(input: RailLayoutInput): boolean {
  const sorted = sortedOf(input)
  const a = activeIndex(input)
  if (a <= 0) return true
  let top = Math.max(sorted[a]!.anchorY, input.minTop)
  for (let i = a - 1; i >= 0; i--) {
    const c = sorted[i]!
    const h = c.pinExpanded === true ? c.height : collapsedHeightOf(c)
    top = Math.min(c.anchorY, top - input.gap - h)
  }
  return top >= input.minTop
}

/** Seeded Fisher–Yates (a small LCG), so a failing case replays. */
function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs]
  let s = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Runs fn with every DOM global replaced by a throwing getter (I6: no DOM access). */
function withoutDom<T>(fn: () => T): T {
  const names = ['window', 'document', 'navigator', 'requestAnimationFrame', 'getComputedStyle', 'ResizeObserver', 'HTMLElement', 'Element']
  const g = globalThis as Record<string, unknown>
  const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)] as const)
  for (const n of names) {
    Object.defineProperty(g, n, {
      configurable: true,
      get() {
        throw new Error(`layoutRail touched the DOM global ${n}`)
      },
    })
  }
  try {
    return fn()
  } finally {
    for (const [n, d] of saved) {
      if (d) Object.defineProperty(g, n, d)
      else delete g[n]
    }
  }
}

// ------------------------------------------------------------------ invariants

describe('layoutRail invariants (§11.2)', () => {
  it('I1: top_active === max(anchorY_active, minTop), and the active card is always placed', () => {
    fc.assert(
      fc.property(inputArb({ active: 'always', minCards: 1 }), (input) => {
        const out = layoutRail(input)
        const card = input.cards.find((c) => c.id === input.activeId)!
        const p = byId(out).get(card.id)
        expect(p).toBeDefined()
        expect(out.overflowAbove).not.toContain(card.id)
        expect(p!.top).toBe(Math.max(card.anchorY, input.minTop))
      }),
      RUNS,
    )
  })

  it('I2: no overlap among placements (top_{i+1} >= top_i + height_i + gap)', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const ps = layoutRail(input).placements
        for (let i = 1; i < ps.length; i++) expect(ps[i]!.top).toBeGreaterThanOrEqual(ps[i - 1]!.top + ps[i - 1]!.height + input.gap - EPS)
      }),
      RUNS,
    )
  })

  it('I3: placement order equals anchor order; overflowAbove is the leading prefix of it', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const out = layoutRail(input)
        const order = sortedOf(input).map((c) => c.id)
        expect([...out.overflowAbove, ...out.placements.map((p) => p.id)]).toEqual(order)
      }),
      RUNS,
    )
  })

  it('I4 (locality): tops above the active card ignore the heights of the active card and every card below it', () => {
    const changes = fc.array(fc.record({ height: fc.integer({ min: 1, max: 2000 }), collapsedHeight: fc.integer({ min: 1, max: 200 }) }), { minLength: 1, maxLength: 30 })
    fc.assert(
      fc.property(inputArb({ active: 'always', minCards: 1 }), changes, (input, ch) => {
        const sorted = sortedOf(input)
        const a = activeIndex(input)
        const belowIds = new Set(sorted.slice(a).map((c) => c.id))
        let j = 0
        const mutated: RailLayoutInput = {
          ...input,
          cards: input.cards.map((c) => (belowIds.has(c.id) ? { ...c, ...ch[j++ % ch.length]! } : c)),
        }
        const before = layoutRail(input)
        const after = layoutRail(mutated)
        expect(after.overflowAbove).toEqual(before.overflowAbove)
        const aboveIds = sorted.slice(0, a).map((c) => c.id)
        const b = byId(before)
        const x = byId(after)
        for (const id of aboveIds) expect(x.get(id)).toEqual(b.get(id))
      }),
      RUNS,
    )
  })

  it('I4 (locality): a reply growing the active card by any amount moves nothing above it', () => {
    fc.assert(
      fc.property(inputArb({ active: 'always', minCards: 2 }), fc.integer({ min: 1, max: 1500 }), (input, grow) => {
        const grown = { ...input, cards: input.cards.map((c) => (c.id === input.activeId ? { ...c, height: c.height + grow } : c)) }
        const before = layoutRail(input)
        const after = layoutRail(grown)
        const a = activeIndex(input)
        const above = new Set<string>(sortedOf(input).slice(0, a).map((c) => c.id))
        expect(after.placements.filter((p) => above.has(p.id))).toEqual(before.placements.filter((p) => above.has(p.id)))
        expect(after.overflowAbove).toEqual(before.overflowAbove)
        expect(byId(after).get(input.activeId!)!.top).toBe(byId(before).get(input.activeId!)!.top)
      }),
      RUNS,
    )
  })

  it('I5: cards above the active card sit at or above their anchor; cards below at or below theirs', () => {
    fc.assert(
      fc.property(inputArb({ active: 'always', minCards: 1 }), (input) => {
        const out = layoutRail(input)
        const sorted = sortedOf(input)
        const a = activeIndex(input)
        const p = byId(out)
        sorted.forEach((c, i) => {
          const pl = p.get(c.id)
          if (!pl) return
          if (i < a) expect(pl.top).toBeLessThanOrEqual(c.anchorY)
          if (i > a) expect(pl.top).toBeGreaterThanOrEqual(c.anchorY)
        })
      }),
      RUNS,
    )
  })

  it('without an active card every card sits at or below its anchor and at or below minTop; nothing overflows', () => {
    fc.assert(
      fc.property(inputArb({ active: 'never' }), (input) => {
        const out = layoutRail(input)
        expect(out.overflowAbove).toEqual([])
        const cards = new Map<string, RailCardInput>(input.cards.map((c) => [c.id, c]))
        for (const p of out.placements) {
          expect(p.top).toBeGreaterThanOrEqual(cards.get(p.id)!.anchorY)
          expect(p.top).toBeGreaterThanOrEqual(input.minTop)
        }
      }),
      RUNS,
    )
  })

  it('I6: pure and deterministic: input order does not matter, repeated calls agree, the input is not mutated, no DOM', () => {
    fc.assert(
      fc.property(inputArb(), fc.integer(), (input, seed) => {
        const frozen = JSON.stringify(input)
        const shuffled = { ...input, cards: shuffle(input.cards, seed) }
        const a = withoutDom(() => layoutRail(input))
        const b = withoutDom(() => layoutRail(shuffled))
        expect(b).toEqual(a)
        expect(layoutRail(input)).toEqual(a)
        expect(JSON.stringify(input)).toBe(frozen)
      }),
      { numRuns: 200 },
    )
  })

  it('I7: the active card and pinExpanded cards are never collapsed and keep their full height', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const out = layoutRail(input)
        const cards = new Map<string, RailCardInput>(input.cards.map((c) => [c.id, c]))
        for (const p of out.placements) {
          const c = cards.get(p.id)!
          if (p.id === input.activeId || c.pinExpanded === true) {
            expect(p.collapsed).toBe(false)
            expect(p.height).toBe(c.height)
          }
        }
      }),
      RUNS,
    )
  })

  it('I8: overflowAbove is non-empty only (and exactly) when the cards above cannot fit even when collapsed', () => {
    fc.assert(
      fc.property(inputArb({ active: 'any' }), (input) => {
        const out = layoutRail(input)
        expect(out.overflowAbove.length > 0).toBe(!fitsWhenCollapsed(input))
      }),
      RUNS,
    )
  })

  it('I8 regression: a full-height card displaced less than collapseDisplacement does not push neighbours into overflow', () => {
    // Pass 1 puts card b at -8 (displacement 98 <= 120, so the literal step 4 would keep it expanded and overflow
    // both a and b); collapsed, both fit under minTop.
    const input: RailLayoutInput = {
      cards: [
        { id: tid(0), anchorY: 0, order: 0, height: 20, collapsedHeight: 20 },
        { id: tid(1), anchorY: 90, order: 1, height: 100, collapsedHeight: 20 },
        { id: tid(2), anchorY: 100, order: 2, height: 50, collapsedHeight: 20 },
      ],
      activeId: tid(2),
      gap: 8,
      minTop: 0,
      collapseDisplacement: 120,
      cluster: { maxAnchorGap: 48, minRun: 4 },
    }
    const out = layoutRail(input)
    expect(out.overflowAbove).toEqual([])
    expect(out.placements.map((p) => [p.top, p.collapsed])).toEqual([[0, true], [72, true], [100, false]])
  })
})

describe('layoutRail: consequences of the algorithm (§11.1)', () => {
  it('every card appears exactly once; displacement = top − anchorY; height covers every placement', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const out = layoutRail(input)
        const ids = [...out.overflowAbove, ...out.placements.map((p) => p.id)]
        expect(new Set(ids).size).toBe(input.cards.length)
        expect(ids.length).toBe(input.cards.length)
        const cards = new Map<string, RailCardInput>(input.cards.map((c) => [c.id, c]))
        for (const p of out.placements) {
          expect(p.displacement).toBe(p.top - cards.get(p.id)!.anchorY)
          expect(p.height).toBe(p.collapsed ? collapsedHeightOf(cards.get(p.id)!) : cards.get(p.id)!.height)
          expect(out.height).toBeGreaterThanOrEqual(p.top + p.height)
        }
        if (out.placements.length === 0) expect(out.height).toBe(0)
      }),
      RUNS,
    )
  })

  it('an expanded card that is neither active nor pinned is never displaced past collapseDisplacement', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const cards = new Map<string, RailCardInput>(input.cards.map((c) => [c.id, c]))
        for (const p of layoutRail(input).placements) {
          if (p.collapsed || p.id === input.activeId || cards.get(p.id)!.pinExpanded === true) continue
          expect(Math.abs(p.displacement)).toBeLessThanOrEqual(input.collapseDisplacement + EPS)
        }
      }),
      RUNS,
    )
  })

  it('cluster members (runs of >= minRun anchors with gaps <= maxAnchorGap) collapse unless active or pinned', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const sorted = sortedOf(input)
        const out = layoutRail(input)
        const p = byId(out)
        let start = 0
        for (let i = 1; i <= sorted.length; i++) {
          if (i < sorted.length && sorted[i]!.anchorY - sorted[i - 1]!.anchorY <= input.cluster.maxAnchorGap) continue
          if (i - start >= input.cluster.minRun) {
            for (const c of sorted.slice(start, i)) {
              const pl = p.get(c.id)
              if (pl && c.id !== input.activeId && c.pinExpanded !== true) expect(pl.collapsed).toBe(true)
            }
          }
          start = i
        }
      }),
      RUNS,
    )
  })

  it('a lone card with no neighbours sits exactly at its anchor (or minTop) and stays expanded', () => {
    fc.assert(
      fc.property(cardArb(0), paramsArb, fc.boolean(), (card, p, active) => {
        const out = layoutRail({
          cards: [card], activeId: active ? card.id : null, gap: p.gap, minTop: p.minTop,
          collapseDisplacement: Math.max(p.collapseDisplacement, p.minTop), cluster: { maxAnchorGap: p.maxAnchorGap, minRun: Math.max(2, p.minRun) },
        })
        expect(out.placements).toEqual([{ id: card.id, top: Math.max(card.anchorY, p.minTop), height: card.height, collapsed: false, displacement: Math.max(card.anchorY, p.minTop) - card.anchorY }])
      }),
      RUNS,
    )
  })

  it('an empty rail lays out to nothing', () => {
    expect(layoutRail({ cards: [], activeId: null, gap: 8, minTop: 40, collapseDisplacement: 120, cluster: { maxAnchorGap: 48, minRun: 3 } })).toEqual({ placements: [], overflowAbove: [], height: 0 })
    expect(layoutRail({ cards: [], activeId: tid(3), gap: 8, minTop: 40, collapseDisplacement: 120, cluster: { maxAnchorGap: 48, minRun: 3 } })).toEqual({ placements: [], overflowAbove: [], height: 0 })
  })

  it('an activeId that is not among the cards lays out as if nothing were active', () => {
    fc.assert(
      fc.property(inputArb({ active: 'never' }), (input) => {
        expect(layoutRail({ ...input, activeId: tid(999) })).toEqual(layoutRail(input))
      }),
      { numRuns: 100 },
    )
  })
})

// ------------------------------------------------------------------ the named case

describe('named case: 10 cards with anchors inside 300 px at y ≈ 0 (§11.2)', () => {
  const MIN_TOP = 48
  const base = (activeIndex: number | null, extra: Partial<RailCardInput> = {}): RailLayoutInput => ({
    cards: Array.from({ length: 10 }, (_, i) => ({ id: tid(i), anchorY: i * 30, order: i, height: 96 + (i % 3) * 40, collapsedHeight: 28, ...extra })),
    activeId: activeIndex === null ? null : tid(activeIndex),
    gap: CONSTANTS.RAIL_GAP,
    minTop: MIN_TOP,
    collapseDisplacement: CONSTANTS.RAIL_COLLAPSE_DISPLACEMENT,
    cluster: { maxAnchorGap: CONSTANTS.RAIL_CLUSTER_MAX_ANCHOR_GAP, minRun: CONSTANTS.RAIL_CLUSTER_MIN_RUN },
  })

  const noOverlap = (out: RailLayoutOutput): void => {
    for (let i = 1; i < out.placements.length; i++) {
      expect(out.placements[i]!.top).toBeGreaterThanOrEqual(out.placements[i - 1]!.top + out.placements[i - 1]!.height + CONSTANTS.RAIL_GAP)
    }
    for (const p of out.placements) expect(p.top).toBeGreaterThanOrEqual(MIN_TOP)
  }

  it('active = the last card: pinned level with its anchor, collapsed cards above, a "+3 above" chip', () => {
    const out = layoutRail(base(9))
    noOverlap(out)
    const active = byId(out).get(tid(9))!
    expect(active.top).toBe(270)
    expect(active.collapsed).toBe(false)
    // collapsed pitch is 28 + 8 = 36: tops 234, 198, 162, 126, 90, 54 fit under minTop 48; cards 0–2 would be 18, -18, -54.
    expect(out.overflowAbove).toEqual([tid(0), tid(1), tid(2)])
    expect(out.placements.map((p) => p.top)).toEqual([54, 90, 126, 162, 198, 234, 270])
    expect(out.placements.slice(0, -1).every((p) => p.collapsed)).toBe(true)
  })

  it('active = the first card: pinned at minTop, everything else below it, no chip', () => {
    const out = layoutRail(base(0))
    noOverlap(out)
    expect(byId(out).get(tid(0))!.top).toBe(MIN_TOP)
    expect(out.overflowAbove).toEqual([])
    expect(out.placements).toHaveLength(10)
  })

  it('active in the middle: pinned at its anchor, the chip counts exactly the cards that cannot fit above', () => {
    for (let a = 0; a < 10; a++) {
      const input = base(a)
      const out = layoutRail(input)
      noOverlap(out)
      expect(byId(out).get(tid(a))!.top).toBe(Math.max(a * 30, MIN_TOP))
      // 36 px per collapsed card above the active one, between minTop and the active top
      const room = Math.max(a * 30, MIN_TOP) - MIN_TOP
      const fit = Math.min(a, Math.floor(room / 36))
      expect(out.overflowAbove).toHaveLength(a - fit)
    }
  })

  it('no active card: forward from minTop, all collapsed, nothing overflows', () => {
    const out = layoutRail(base(null))
    noOverlap(out)
    expect(out.overflowAbove).toEqual([])
    expect(out.placements[0]!.top).toBe(MIN_TOP)
    expect(out.placements.every((p) => p.collapsed)).toBe(true)
  })

  it('a pinned (draft) card above the active one stays expanded; the chip grows to make room', () => {
    const input = base(9)
    input.cards[7] = { ...input.cards[7]!, pinExpanded: true }
    const out = layoutRail(input)
    noOverlap(out)
    const pinned = byId(out).get(tid(7))
    expect(pinned?.collapsed).toBe(false)
    expect(byId(out).get(tid(9))!.top).toBe(270)
    // pinned card 7 (136 px) sits at 234 − 8 − 136 = 90; card 6 at 54; cards 0–5 cannot fit under minTop 48
    expect(pinned?.top).toBe(90)
    expect(out.overflowAbove).toEqual([0, 1, 2, 3, 4, 5].map(tid))
  })
})
