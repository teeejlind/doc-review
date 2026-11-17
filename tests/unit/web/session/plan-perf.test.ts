// tests/unit/web/session/plan-perf.test.ts (P2; CONTRACTS §11.7 "P2's keystroke-path rules"). One autosave plan on a
// 10k-word doc with 50 threads (40 comments, 10 Claude suggestions), in jsdom, through the real editor's EditorPort.
//
// The budget is ≤ 30 ms for one plan. Since M1, applyBlockOps verifies the way §3.4 says: it re-classifies the whole
// assembled text once, and on this fixture one classifyText alone takes ≈ 28 ms in jsdom (≈ 40 ms beside the other
// vitest workers), so the full plan cannot fit 30 ms by itself whatever P2 does (contract-changes/P2.md, plan-perf
// row). This file asserts what P2 controls and what can regress: P2's share (baseDoc, planSave, tjSuggestionDiff and
// extract, anchor updates) ≤ 30 ms, and the full plan minus that one mandated re-classify ≤ 30 ms (so an extra
// re-classify, a widening on a clean edit or a slow assembly still fails). It reports all three figures.
import { describe, expect, it } from 'vitest'
import { applyBlockOps } from '../../../../core/splice/apply'
import { classifyText } from '../../../../core/splice/load'
import { planSave } from '../../../../core/splice/plan'
import { mount, replace } from '../editor/helpers'

const BUDGET_MS = 30

function tenKWords(): string {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ')
  const parts = ['---', 'title: Perf fixture', '---', '', '# Perf fixture', '']
  for (let i = 0; i < 500; i++) {
    if (i % 50 === 0) parts.push(`## Section ${i / 50}`, '')
    parts.push(`${Array.from({ length: 20 }, (_, k) => words[(i + k) % words.length]).join(' ')} p${i}x.`, '')
  }
  return parts.join('\n')
}

describe('plan perf (§11.7)', () => {
  it(`one autosave plan on 10k words / 50 threads stays within ${BUDGET_MS} ms (P2's share, and the full plan beside §3.4's one whole-text re-classify)`, async () => {
    const ops: Array<Record<string, unknown>> = []
    for (let i = 0; i < 40; i++) ops.push({ op: 'comment', quote: `p${i * 12}x`, body: `comment ${i}` })
    for (let i = 0; i < 10; i++) ops.push({ op: 'suggest', quote: `p${i * 12 + 6}x`, replace: `p${i * 12 + 6}y` })
    const m = await mount({ markdown: tenKWords(), claude: ops })
    try {
      const review = m.session.getReview()
      expect(review.threads.length).toBe(50)
      m.bridge.setMode('suggesting')
      replace(m.view, 'p250x', 'p250z')
      m.bridge.setMode('editing')
      replace(m.view, 'p300x', 'p300w')
      const L = m.internals.getLoaded()!
      const share: number[] = []
      const full: number[] = []
      const classify: number[] = []
      const rest: number[] = []
      // two warm-up rounds (JIT, extract cache), then the median of seven: the suite runs this beside other workers
      for (let r = 0; r < 9; r++) {
        ;(m.ed as unknown as { baseCache: null }).baseCache = null
        const t0 = performance.now()
        const base = m.ed.baseDoc()
        const planned = planSave(m.ed.md, L, base)
        m.ed.suggestionPlan(L, review)
        m.ed.anchorUpdates(L, review)
        const t1 = performance.now()
        const applied = applyBlockOps(m.ed.md, L, planned)
        const t2 = performance.now()
        // the one whole-text re-classify §3.4 verification performs, timed on its own in the same round
        classifyText(m.ed.md, applied.text)
        const t3 = performance.now()
        expect(applied.widened).toEqual([])
        expect(applied.failed).toEqual([])
        if (r < 2) continue
        share.push(t1 - t0)
        full.push(t2 - t0)
        classify.push(t3 - t2)
        rest.push(t2 - t0 - (t3 - t2))
      }
      const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
      console.info(`[plan-perf] P2 share median ${median(share).toFixed(1)} ms; full plan median ${median(full).toFixed(1)} ms; ` +
        `one whole-text classifyText ${median(classify).toFixed(1)} ms; full minus it ${median(rest).toFixed(1)} ms`)
      expect(median(share)).toBeLessThanOrEqual(BUDGET_MS)
      expect(median(rest)).toBeLessThanOrEqual(BUDGET_MS)
    } finally {
      await m.close()
    }
  }, 120_000)
})
