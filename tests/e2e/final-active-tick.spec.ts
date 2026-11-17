// tests/e2e/final-active-tick.spec.ts (TJ, 2026-11-16, onboarding walkthrough on 0.1.5). The gutter tick between the
// document and the rail is level with the first line of its card's anchor, for every card that has one, active or not,
// whatever the card's height. Before the fix the active card had no tick (it sits level with its line, so it is never
// displaced, and ticks were drawn for displaced cards only); the one tick beside a tall active card was the next card's,
// pushed below it, which read as the active card's tick sitting halfway down the card next to an unrelated paragraph.
//
// Measured in the window: the tick's top against the top of the first line of its anchor's highlight (a scroll moves
// both). Run in Editing and in Suggesting.
import type { Page } from '@playwright/test'
import type { EditorPage } from '../helpers/openEditor'
import { claude, openDoc } from './fixtures/p2'
import { railDoc, railSettled, sel } from './fixtures/p3'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const FILE = 'ticks.md'
const LONG = 'This note runs long on purpose, so that its card takes many lines in the rail once it is open. '.repeat(5)
/** The tall card's anchor wraps onto a second line at the reading measure: the tick goes on the first. */
const WRAPPING = 'kq0x opens a sentence that keeps going well past the end of the first line so that its highlight wraps onto a second line of the paragraph'

function doc(): string {
  const paras = railDoc(20).split('\n\n').filter(Boolean)
  paras.splice(6, 0, `${WRAPPING}.`, 'Beta line carries kq1x here.', 'Gamma line carries kq2x here.')
  return paras.join('\n\n') + '\n'
}

interface TickLevel {
  hlTop: number
  tickTop: number | null
  tickActive: string | undefined
  cardTop: number
  cardHeight: number
  cardActive: string | undefined
}

const measure = (page: Page, thread: string): Promise<TickLevel> =>
  page.evaluate(
    ([cardSel, hlSel, id]) => {
      const card = document.querySelector<HTMLElement>(cardSel!)!
      const hlTop = Math.min(...Array.from(document.querySelectorAll<HTMLElement>(hlSel!)).flatMap((h) => Array.from(h.getClientRects()).map((r) => r.top)))
      const tick = document.querySelector<HTMLElement>(`.mdr-ticks .mdr-tick[data-card="${id}"]`)
      const r = card.getBoundingClientRect()
      return {
        hlTop,
        tickTop: tick ? tick.getBoundingClientRect().top : null,
        tickActive: tick?.dataset.active,
        cardTop: r.top,
        cardHeight: r.height,
        cardActive: card.dataset.active,
      }
    },
    [sel('card', { 'data-thread': thread }), sel('highlight', { 'data-thread': thread }), thread] as const,
  )

async function expectTickLevel(page: Page, thread: string, label: string, active: boolean): Promise<TickLevel> {
  const m = await measure(page, thread)
  const where = `${label}: tick ${m.tickTop?.toFixed(1)}, first line ${m.hlTop.toFixed(1)}, card ${m.cardTop.toFixed(1)}+${m.cardHeight.toFixed(0)}`
  expect(m.cardActive, `${where}: card active`).toBe(String(active))
  expect(m.tickTop, `${where}: has a tick`).not.toBeNull()
  expect(Math.abs(m.tickTop! - m.hlTop), where).toBeLessThanOrEqual(2)
  expect(m.tickActive, `${where}: tick marked active`).toBe(String(active))
  return m
}

for (const mode of ['editing', 'suggesting'] as const) {
  test(`${mode}: the tick is level with the first line of its anchor for a tall active card, a short active card and an idle one`, async ({ page, server, tmpRoot }) => {
    const ed: EditorPage = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: doc() })
    await ed.bridge((b, m) => b.setMode(m), mode)
    expect(await ed.bridge((b) => b.getMode())).toBe(mode)
    const made = await claude(server, FILE, [
      { op: 'comment', quote: WRAPPING, body: LONG },
      { op: 'comment', quote: 'kq1x', body: 'Short.' },
      { op: 'comment', quote: 'kq2x', body: LONG },
    ])
    const [tall, short, other] = made.results.map((r) => r.thread!) as [string, string, string]
    await expect(page.locator(sel('card'))).toHaveCount(3)
    await railSettled(page, 300)

    // the tall card's anchor really wraps, so "first line" means something
    const lines = await page.evaluate((s) => new Set(Array.from(document.querySelectorAll<HTMLElement>(s)).flatMap((h) => Array.from(h.getClientRects()).map((r) => Math.round(r.top)))).size, sel('highlight', { 'data-thread': tall }))
    expect(lines).toBeGreaterThan(1)

    // a tall active card: its own tick on its first line, and the idle cards it pushes down keep theirs on their lines
    await page.locator(sel('highlight', { 'data-thread': tall })).first().click()
    await railSettled(page, 400)
    const t = await expectTickLevel(page, tall, 'tall active', true)
    expect(t.cardHeight, 'the active card is tall').toBeGreaterThan(250)
    expect(Math.abs(t.cardTop - t.hlTop), 'the active card is level with its line').toBeLessThanOrEqual(2)
    await expectTickLevel(page, short, 'idle, pushed below the tall active card', false)
    await expectTickLevel(page, other, 'idle, pushed below the tall active card', false)
    expect(await page.locator('.mdr-ticks .mdr-tick[data-active="true"]').count(), 'one active tick').toBe(1)

    // a short active card
    await page.locator(sel('highlight', { 'data-thread': short })).first().click()
    await railSettled(page, 400)
    await expectTickLevel(page, short, 'short active', true)
    await expectTickLevel(page, other, 'idle, below the short active card', false)
    expect(await page.locator('.mdr-ticks .mdr-tick[data-active="true"]').count(), 'one active tick').toBe(1)

    // the last one tall and active, from its card
    await page.locator(sel('card', { 'data-thread': other })).locator('.mdr-card-label').click()
    await railSettled(page, 400)
    await expectTickLevel(page, other, 'tall active, from its card', true)
    expect(await page.locator('.mdr-ticks .mdr-tick[data-active="true"]').count(), 'one active tick').toBe(1)
  })
}
