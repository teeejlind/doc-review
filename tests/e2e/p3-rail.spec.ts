// tests/e2e/p3-rail.spec.ts (P3; CONTRACTS §11.2, §11.3, §11.4, §14 P3 E2E "p3-rail").
//
// The rail in a real browser: no overlaps, cards level with their anchors, scrolling 500 px changes no card's
// top − anchorY and runs no layout, a card-body click keeps the card under the cursor while the doc scrolls, the
// active card stays level with its anchor, and a resize relayouts. Before P2 lands this runs on the fake P2 modules:
// `MDR_FAKE_EDITOR=1 npm run e2e -- tests/e2e/p3-*`. The reply-composer cases (composer exemption, off-screen pill, a
// 15-line reply growing downward) and the narrow sheet are below.
import { CONSTANTS } from '../../shared/constants'
import type { AgentOp } from '../../shared/types'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { P3_SERVER_KIND, railDoc, railSettled, railState, selectText, type RailState } from './fixtures/p3'
import { TESTID } from '../../shared/constants'

test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: 'rail.md' })

const FILE = 'rail.md'
const GAP = CONSTANTS.RAIL_GAP

function expectNoOverlap(s: RailState): void {
  const placed = s.cards.filter((c) => c.placed === 'true').sort((a, b) => a.top - b.top)
  for (let i = 1; i < placed.length; i++) expect(placed[i]!.top, `${placed[i]!.thread} vs ${placed[i - 1]!.thread}`).toBeGreaterThanOrEqual(placed[i - 1]!.bottom + GAP - 0.5)
}

test.describe('p3-rail', () => {
  test.beforeEach(async ({ tmpRoot, cli, server }) => {
    void server
    tmpRoot.write(FILE, railDoc())
    const ops: AgentOp[] = [
      { op: 'comment', quote: 'marker1x', body: 'First comment on paragraph 1.' },
      { op: 'comment', quote: 'marker2x', body: 'Second.' },
      { op: 'comment', quote: 'marker3x', body: 'Third, with a longer body so the card wraps onto a couple of lines in the rail and takes more room.' },
      { op: 'comment', quote: 'marker4x', body: 'Fourth.' },
      { op: 'comment', quote: 'marker12x', body: 'Lone comment further down.' },
      { op: 'comment', quote: 'marker30x', body: 'Near the end.' },
    ]
    const r = await cli.batch(FILE, { ops })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
  })

  test('cards sit level with their anchors without overlapping; scrolling 500 px changes nothing', async ({ page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    await expect(ed.testid('card')).toHaveCount(6)
    await railSettled(page)
    const before = await railState(page)
    expectNoOverlap(before)
    for (const c of before.cards) {
      expect(c.placed).toBe('true')
      expect(c.anchor).not.toBeNull()
      // nothing is active: every card sits at or below its anchor, and the lone ones exactly on it
      expect(c.top).toBeGreaterThanOrEqual(Math.max(c.anchor!, before.minTop) - 0.5)
    }
    const lone = before.cards.filter((c, i) => i === 0 || i >= 4)
    for (const c of lone) expect(Math.abs(c.top - Math.max(c.anchor!, before.minTop))).toBeLessThanOrEqual(0.5)

    // every layout frame rewrites data-placed on each card (setAttribute queues a record even for the same value),
    // so zero attribute records across the scroll means zero layout runs (§11.3)
    await page.evaluate(() => {
      const w = window as unknown as { __railWrites: number }
      w.__railWrites = 0
      const mo = new MutationObserver((recs) => (w.__railWrites += recs.length))
      for (const el of document.querySelectorAll('[data-testid="mdr-card"]')) mo.observe(el, { attributes: true, attributeFilter: ['data-placed', 'data-collapsed', 'style'] })
      document.getElementById('mdr-scroll')!.scrollTop += 500
    })
    await railSettled(page, 50)
    expect(await page.evaluate(() => (window as unknown as { __railWrites: number }).__railWrites)).toBe(0)
    const after = await railState(page)
    expect(after.scrollTop).toBe(before.scrollTop + 500)
    for (let i = 0; i < before.cards.length; i++) {
      expect(after.cards[i]!.top - after.cards[i]!.anchor!).toBeCloseTo(before.cards[i]!.top - before.cards[i]!.anchor!, 3)
      expect(after.cards[i]!.top).toBeCloseTo(before.cards[i]!.top, 3)
    }
  })

  test('a card-body click keeps the card under the cursor; the doc scrolls and the card pins level with its anchor', async ({ page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    await expect(ed.testid('card')).toHaveCount(6)
    await railSettled(page)
    await page.evaluate(() => {
      document.getElementById('mdr-scroll')!.scrollTop = 300
    })
    await railSettled(page, 50)
    const s0 = await railState(page)
    // the most displaced card of the cluster
    const target = [...s0.cards].sort((a, b) => b.top - b.anchor! - (a.top - a.anchor!))[0]!
    expect(target.top - target.anchor!).toBeGreaterThan(GAP)
    const card = ed.testid('card', { 'data-thread': target.thread })
    const box = (await card.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height - 4, 30))
    await railSettled(page)
    const s1 = await railState(page)
    const t1 = s1.cards.find((c) => c.thread === target.thread)!
    expect(t1.active).toBe(true)
    await expect(card).toHaveAttribute('data-active', 'true')
    expect(Math.abs(t1.top - Math.max(t1.anchor!, s1.minTop))).toBeLessThanOrEqual(0.5)
    expect(Math.abs(t1.clientTop - target.clientTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(s1.scrollTop - (s0.scrollTop - (target.top - t1.top)))).toBeLessThanOrEqual(1)
    expectNoOverlap(s1)
    // every card above the active one sits at or above its anchor
    for (const c of s1.cards) if (c.anchor! < t1.anchor!) expect(c.top).toBeLessThanOrEqual(c.anchor! + 0.5)
  })

  test('a window resize reflows the doc and the cards follow their anchors', async ({ page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    await expect(ed.testid('card')).toHaveCount(6)
    await railSettled(page)
    const wide = await railState(page)
    await page.setViewportSize({ width: 1000, height: 900 })
    await railSettled(page)
    const narrow = await railState(page)
    const lone = (s: RailState) => s.cards.filter((_, i) => i === 0 || i >= 4)
    // the column narrows, lines wrap more, anchors move down; the lone cards stay level with them
    expect(lone(narrow).at(-1)!.anchor!).toBeGreaterThan(lone(wide).at(-1)!.anchor!)
    for (const c of lone(narrow)) expect(Math.abs(c.top - Math.max(c.anchor!, narrow.minTop))).toBeLessThanOrEqual(0.5)
    expectNoOverlap(narrow)
  })

  test('a block inserted above an anchor moves its card within one frame', async ({ page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    await expect(ed.testid('card')).toHaveCount(6)
    await railSettled(page)
    const s0 = await railState(page)
    const last = s0.cards.at(-1)!
    const hasFake = await page.evaluate(() => typeof (window as unknown as { __mdrFake?: { bridge?: { insertBlockAbove?: unknown } } }).__mdrFake?.bridge?.insertBlockAbove === 'function')
    test.skip(!hasFake, 'the real-editor variant (typing a paragraph above the anchor) lands with the P2 merge')
    // insert, then sample positions on the very next frame (the card's transform is written in that frame)
    const moved = await page.evaluate(async (id) => {
      const fake = (window as unknown as { __mdrFake: { bridge: { insertBlockAbove(id: string, px: number): void } } }).__mdrFake
      const card = document.querySelector<HTMLElement>(`[data-testid="mdr-card"][data-thread="${id}"]`)!
      const before = card.style.transform
      fake.bridge.insertBlockAbove(id, 200)
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      return { before, after: card.style.transform }
    }, last.thread)
    const ty = (t: string): number => Number(/translateY\((-?[\d.]+)px\)/.exec(t)![1])
    expect(ty(moved.after) - ty(moved.before)).toBeCloseTo(200, 0)
  })

  test('card follows its anchor within one frame of an edit above it, sampled every frame (fake insert or real typing)', async ({ page, server }) => {
    // card moves animate (§11.4, CARD_MOVE_MS); reduced motion makes them instant so the rendered rects can be sampled
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    await expect(ed.testid('card')).toHaveCount(6)
    await railSettled(page)
    const s0 = await railState(page)
    // the card under test is a lone one (marker12x): no neighbour pushes it
    const lone = s0.cards[4]!
    expect(lone.anchor).not.toBeNull()
    const hasFake = await page.evaluate(() => typeof (window as unknown as { __mdrFake?: { bridge?: { insertBlockAbove?: unknown } } }).__mdrFake?.bridge?.insertBlockAbove === 'function')

    // card top − anchor top on every frame, in client coordinates (a scroll moves both equally)
    await page.evaluate(
      ({ id, cardId, hlId }) => {
        const w = window as unknown as { __frames: Array<{ card: number; anchor: number }>; __sampling: boolean }
        w.__frames = []
        w.__sampling = true
        const card = document.querySelector<HTMLElement>(`[data-testid="${cardId}"][data-thread="${id}"]`)!
        const tick = (): void => {
          const hl = document.querySelector(`[data-testid="${hlId}"][data-thread="${id}"]`)
          if (hl) w.__frames.push({ card: card.getBoundingClientRect().top, anchor: hl.getBoundingClientRect().top })
          if (w.__sampling) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      },
      { id: lone.thread, cardId: TESTID.card, hlId: TESTID.highlight },
    )
    await railSettled(page, 50)
    const start = await page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames.length)
    expect(start).toBeGreaterThan(0)

    if (hasFake) {
      await page.evaluate((id) => {
        const fake = (window as unknown as { __mdrFake: { bridge: { insertBlockAbove(id: string, px: number): void } } }).__mdrFake
        fake.bridge.insertBlockAbove(id, 200)
      }, lone.thread)
    } else {
      // the real editor: four empty paragraphs typed above the anchor (Enter at the start of paragraph 8)
      await selectText(page, { from: 'Paragraph 8 ', collapseAt: 'start' })
      for (let i = 0; i < 4; i++) await page.keyboard.press('Enter')
    }
    await page.waitForFunction((n) => (window as unknown as { __frames: unknown[] }).__frames.length >= n + 30, start)
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: Array<{ card: number; anchor: number }>; __sampling: boolean }
      w.__sampling = false
      return w.__frames
    })
    const base = frames[start - 1]!
    const d0 = base.card - base.anchor
    const after = frames.slice(start)
    expect(Math.abs(after.at(-1)!.anchor - base.anchor), 'the edit moved the anchor').toBeGreaterThan(40)
    // off its anchor for at most one sampled frame at a time: in the frame of the edit the sampler can run before the
    // scheduler's callback, but never two frames running
    let run = 0
    for (const [i, f] of after.entries()) {
      run = Math.abs(f.card - f.anchor - d0) > 1 ? run + 1 : 0
      expect(run, `frame ${i}: card ${f.card}, anchor ${f.anchor}, offset should be ${d0}`).toBeLessThanOrEqual(1)
    }
    expect(Math.abs(after.at(-1)!.card - after.at(-1)!.anchor - d0)).toBeLessThanOrEqual(1)
  })

  test('the body face finishing its load relayouts the rail: cards follow the reflowed anchors (§11.3, §12.2.3)', async ({ page, server }) => {
    // hold the bundled Source Serif files, so the first layout happens in the fallback face (font-display: swap)
    const held: Array<() => Promise<void>> = []
    let release = false
    await page.route('**/assets/source-serif-4-*.woff2', async (route) => {
      if (release) await route.continue()
      else held.push(() => route.continue())
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    // not openEditor: a held font request holds the load event, so wait for the DOM and the cards instead
    await page.goto(`http://127.0.0.1:${server.port}/?file=${encodeURIComponent(FILE)}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator(`[data-testid="${TESTID.card}"][data-placed="true"]`)).toHaveCount(6)
    // pin the editor host's box (what the scheduler's ResizeObserver watches) well above the doc's height, so the
    // reflow can't resize it: only the document.fonts listener can notice the swap
    await page.addStyleTag({ content: '#mdr-editor-host { min-height: 40000px; width: 700px; }' })
    await railSettled(page)
    expect(held.length, 'the page asked for the body face').toBeGreaterThan(0)
    expect(await page.evaluate(() => document.fonts.check('16px "Source Serif 4 Variable"'))).toBe(false)
    const before = await railState(page)
    for (const c of before.cards) expect(c.placed).toBe('true')

    await page.evaluate(() => {
      const w = window as unknown as { __railWrites: number }
      w.__railWrites = 0
      const mo = new MutationObserver((recs) => (w.__railWrites += recs.length))
      for (const el of document.querySelectorAll('[data-testid="mdr-card"]')) mo.observe(el, { attributes: true, attributeFilter: ['data-placed', 'style'] })
    })
    release = true
    for (const go of held.splice(0)) await go()
    await page.waitForFunction(() => document.fonts.status === 'loaded' && document.fonts.check('16px "Source Serif 4 Variable"'))
    await railSettled(page)
    const after = await railState(page)

    // the swap reflowed the text, so anchors moved; a layout ran; the lone cards sit level with their new anchors
    const shifts = after.cards.map((c, i) => Math.abs(c.anchor! - before.cards[i]!.anchor!))
    expect(Math.max(...shifts), 'the face swap moved at least one anchor').toBeGreaterThan(1)
    expect(await page.evaluate(() => (window as unknown as { __railWrites: number }).__railWrites)).toBeGreaterThan(0)
    for (const c of after.cards.filter((_, i) => i === 0 || i >= 4)) expect(Math.abs(c.top - Math.max(c.anchor!, after.minTop))).toBeLessThanOrEqual(0.5)
    expectNoOverlap(after)
  })
})

test.describe('p3-rail: reply composers (§11.4, R3.4)', () => {
  const TALL = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long note.`).join('\n')
  test.beforeEach(async ({ tmpRoot, cli, server }) => {
    void server
    tmpRoot.write(FILE, railDoc())
    const ops: AgentOp[] = [
      { op: 'comment', quote: 'marker1x', body: TALL },
      { op: 'comment', quote: 'marker2x', body: 'Short one, pushed far below its anchor by the tall card above.' },
      { op: 'comment', quote: 'marker12x', body: 'Lone comment further down.' },
      { op: 'comment', quote: 'marker14x', body: 'Its neighbour below.' },
    ]
    const r = await cli.batch(FILE, { ops })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
  })

  test('clicking into the reply box of an inactive, displaced card never scrolls the doc: the card moves to its anchor and the off-screen pill appears', async ({ page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    await expect(ed.testid('card')).toHaveCount(4)
    await railSettled(page)
    const s0 = await railState(page)
    const short = s0.cards[1]!
    expect(short.top - short.anchor!).toBeGreaterThan(CONSTANTS.RAIL_COLLAPSE_DISPLACEMENT)
    expect(short.collapsed).toBe('true')
    // scroll so the short card's anchor is well above the fold while the card itself is on screen (not at the very end
    // of the scroll box: it ends a dock's height below the last card, and a repack that frees that room is a clamp)
    await page.evaluate((y) => {
      document.getElementById('mdr-scroll')!.scrollTop = y
    }, short.anchor! + 200)
    await railSettled(page, 50)
    const card = ed.testid('card', { 'data-thread': short.thread })
    // hovering a collapsed card opens it as an overlay (no relayout), which shows its reply box
    await card.hover()
    const box = card.locator(`[data-testid="${TESTID.cardReply}"]`)
    const bb = (await box.boundingBox())!
    const before = await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await railSettled(page)
    expect(await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)).toBe(before)
    await expect(card).toHaveAttribute('data-active', 'true')
    await expect(box).toBeFocused()
    const s1 = await railState(page)
    const moved = s1.cards.find((c) => c.thread === short.thread)!
    expect(Math.abs(moved.top - Math.max(moved.anchor!, s1.minTop))).toBeLessThanOrEqual(0.5)
    const pill = ed.testid('offscreenPill')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-direction', 'up')
    // typing in the off-screen composer is allowed, and scrolls nothing
    await page.keyboard.type('typed while off screen')
    expect(await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)).toBe(before)
    await expect(box).toHaveValue('typed while off screen')
    // the pill is the one way back: the anchor lands 30% from the top
    await pill.click()
    await railSettled(page)
    const frac = await page.evaluate((id) => {
      const sc = document.getElementById('mdr-scroll')!
      const hl = document.querySelector(`[data-testid="mdr-highlight"][data-thread="${id}"]`)!
      return (hl.getBoundingClientRect().top - sc.getBoundingClientRect().top) / sc.clientHeight
    }, short.thread)
    expect(frac).toBeGreaterThan(0.25)
    expect(frac).toBeLessThan(0.35)
    await expect(pill).toBeHidden()
  })

  test('a 15-line reply grows the active card downward: the doc doesn’t scroll, the card stays level, cards above stay put', async ({ page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    await expect(ed.testid('card')).toHaveCount(4)
    await railSettled(page)
    const s0 = await railState(page)
    const lone = s0.cards[2]!
    await page.evaluate((y) => {
      document.getElementById('mdr-scroll')!.scrollTop = y
    }, lone.anchor! - 120)
    await railSettled(page, 50)
    const card = ed.testid('card', { 'data-thread': lone.thread })
    await card.locator(`[data-testid="${TESTID.cardReply}"]`).click()
    await railSettled(page)
    const s1 = await railState(page)
    const a1 = s1.cards.find((c) => c.thread === lone.thread)!
    expect(a1.active).toBe(true)
    await page.keyboard.type(Array.from({ length: 15 }, (_, i) => `reply line ${i + 1}`).join('\n'))
    await railSettled(page)
    const s2 = await railState(page)
    const a2 = s2.cards.find((c) => c.thread === lone.thread)!
    expect(s2.scrollTop).toBe(s1.scrollTop)
    expect(a2.top).toBeCloseTo(a1.top, 3)
    expect(a2.bottom - a1.bottom).toBeGreaterThan(200)
    for (const c of s2.cards) {
      const before = s1.cards.find((x) => x.thread === c.thread)!
      if (c.anchor! < a2.anchor!) expect(c.top).toBeCloseTo(before.top, 3)
    }
    expectNoOverlap(s2)
  })
})

test.describe('p3-rail: narrow sheet (§11.4 "Narrow mode")', () => {
  test.beforeEach(async ({ tmpRoot, cli, server }) => {
    void server // the CLI reaches the running server (the day-0 direct mode has no store)
    tmpRoot.write(FILE, railDoc())
    const r = await cli.batch(FILE, {
      ops: [
        { op: 'comment', quote: 'marker1x', body: 'First, in the sheet.' },
        { op: 'comment', quote: 'marker3x', body: 'Second, in the sheet.' },
        { op: 'comment', doc: true, body: 'On the whole document.' },
      ],
    })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
  })

  test('below 640 px: no rail layout; a highlight tap opens the sheet on that thread; back at 640 px the rail returns', async ({ page, server }) => {
    await page.setViewportSize({ width: 639, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: FILE })
    const sheet = page.locator(`[data-testid="${TESTID.sheet}"]`)
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveAttribute('data-open', 'false')
    // no positioned cards at all: nothing in the rail, nothing placed by a scheduler
    await expect(page.locator(`[data-testid="${TESTID.rail}"] [data-testid="${TESTID.card}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-testid="${TESTID.card}"][data-placed]`)).toHaveCount(0)
    const hl = ed.testid('highlight').nth(1)
    const thread = await hl.getAttribute('data-thread')
    await hl.click()
    await expect(sheet).toHaveAttribute('data-open', 'true')
    const card = sheet.locator(`[data-testid="${TESTID.card}"][data-thread="${thread}"]`)
    await expect(card).toHaveAttribute('data-active', 'true')
    await expect(card).toBeInViewport()
    // the rail header's items sit at the top of the sheet (the switches behind its settings button)
    await sheet.locator(`[data-testid="${TESTID.railHeader}"] [data-testid="${TESTID.railSettings}"]`).click()
    await expect(sheet.locator(`[data-testid="${TESTID.railHeader}"] [data-testid="${TESTID.policyToggle}"]`)).toBeVisible()
    // Escape closes the innermost thing first: the settings popover (focus goes back to its gear), then the sheet (T2 polish #38)
    await page.keyboard.press('Escape')
    await expect(sheet.locator(`[data-testid="${TESTID.railSettings}"]`)).toHaveAttribute('aria-expanded', 'false')
    await expect(sheet).toHaveAttribute('data-open', 'true')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveAttribute('data-open', 'false')
    await page.setViewportSize({ width: 640, height: 900 })
    await expect(sheet).toHaveCount(0)
    await railSettled(page)
    await expect(page.locator(`[data-testid="${TESTID.rail}"] [data-testid="${TESTID.card}"][data-placed="true"]`)).toHaveCount(2)
  })
})
