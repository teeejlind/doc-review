// tests/e2e/qa3-r1-rail-ui.spec.ts (QA round 3, fixer "rail-ui", round 1).
//
// The findings that need a real layout and the real server: what the rail does with its geometry, scroll and focus.
// (The ones jsdom can check live in tests/unit/web/threads/qa3-rail-ui.test.tsx.)
import { TESTID } from '../../shared/constants'
import type { Page } from '@playwright/test'
import { claude, openDoc, placeCaret } from './fixtures/p2'
import { agentHeaders } from '../helpers/startServer'
import { installClipboard, railDoc, railSettled, selectText } from './fixtures/p3'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1280, height: 900 } })

const sel = (key: keyof typeof TESTID, extra: string | Record<string, string> = ''): string =>
  `[data-testid="${TESTID[key]}"]` + (typeof extra === 'string' ? extra : Object.entries(extra).map(([k, v]) => `[${k}="${v}"]`).join(''))

/** Scroll so the line holding `text` sits `y` px below the top of the scroll box (as TJ would before selecting it). */
async function scrollTextTo(page: Page, text: string, y: number): Promise<void> {
  await page.evaluate(([t, at]) => {
    const sc = document.getElementById('mdr-scroll')!
    const root = document.querySelector('#mdr-editor-host .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const i = n.data.indexOf(t as string)
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + (t as string).length)
      // `at` is a window y below the original 48 px top bar (onboarding added the file strip, so the scroller now starts
        // lower): the word lands where these tests always put it on screen, whatever the bar's height
        sc.scrollTop += r.getBoundingClientRect().top - 48 - (at as number)
      return
    }
    throw new Error(`no text ${t}`)
  }, [text, y] as const)
  await railSettled(page, 50)
}

/** Looking at it: QA3_SHOTS=<dir> saves a screenshot per call (nothing otherwise). */
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.QA3_SHOTS) await page.screenshot({ path: `${process.env.QA3_SHOTS}/${name}.png` })
}

const scrollTop = (page: Page): Promise<number> => page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)
const textTop = (page: Page, text: string): Promise<number> =>
  page.evaluate((t) => {
    const root = document.querySelector('#mdr-editor-host .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const i = n.data.indexOf(t)
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + t.length)
      return r.getBoundingClientRect().top - document.getElementById('mdr-scroll')!.getBoundingClientRect().top
    }
    return Number.NaN
  }, text)

const PARAS = Array.from({ length: 8 }, (_, i) => `Paragraph 0${i + 1} base text.`).join('\n\n') + '\n'

test('rail-ui 13: Claude deleting the block TJ is typing in leaves a visible conflict card with both choices', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'conc.md', content: PARAS })
  await placeCaret(page, 'Paragraph 05 base', 'end')
  await page.keyboard.type(' ' + Array.from({ length: 40 }, (_, i) => `w${String(i).padStart(4, '0')}`).join(' '))
  await claude(server, 'conc.md', [{ op: 'delete_block', target: { quote: 'Paragraph 05 base text.' } }])

  const chip = page.locator(sel('saveChip'))
  await expect(chip).toContainText('Conflict', { timeout: 15_000 })
  // the chip points at a card TJ can see and act on, not an empty one
  const card = page.locator(sel('conflictCard'))
  await expect(card).toHaveCount(1)
  await expect(card).toBeVisible()
  await expect(card).toContainText('deleted')
  await expect(card.locator(sel('cardAction', '[data-action="keep-mine"]'))).toBeVisible()
  await expect(card.locator(sel('cardAction', '[data-action="take-theirs"]'))).toBeVisible()
  // and clicking the chip takes him to it
  await chip.click()
  await expect(card).toBeInViewport()
  // Keep mine puts his paragraph back; nothing is lost
  await card.locator(sel('cardAction', '[data-action="keep-mine"]')).click()
  await expect(page.locator(sel('conflictCard'))).toHaveCount(0)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('conc.md'), { timeout: 15_000 }).toContain('w0039')
  await expect(chip).toHaveAttribute('data-state', 'saved', { timeout: 15_000 })
})

test('rail-ui 13: at 600px the conflict card is in the sheet, visible, with both choices', async ({ page, server, tmpRoot }) => {
  await page.setViewportSize({ width: 600, height: 800 })
  await openDoc(page, { port: server.port, tmpRoot, file: 'conc.md', content: PARAS })
  await placeCaret(page, 'Paragraph 05 base', 'end')
  await page.keyboard.type(' typed while Claude deleted this paragraph')
  await claude(server, 'conc.md', [{ op: 'delete_block', target: { quote: 'Paragraph 05 base text.' } }])
  await expect(page.locator(sel('saveChip'))).toContainText('Conflict', { timeout: 15_000 })
  await page.locator(sel('saveChip')).click()
  const card = page.locator(sel('sheet')).locator(sel('conflictCard'))
  await expect(card).toBeVisible()
  await expect(card.locator(sel('cardAction', '[data-action="keep-mine"]'))).toBeVisible()
  await expect(card.locator(sel('cardAction', '[data-action="take-theirs"]'))).toBeVisible()
})

test('rail-ui 13: Take theirs lets Claude’s delete stand', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'conc.md', content: PARAS })
  await placeCaret(page, 'Paragraph 05 base', 'end')
  await page.keyboard.type(' typed while Claude deleted this paragraph')
  await claude(server, 'conc.md', [{ op: 'delete_block', target: { quote: 'Paragraph 05 base text.' } }])
  const card = page.locator(sel('conflictCard'))
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.locator(sel('cardAction', '[data-action="take-theirs"]')).click()
  await expect(page.locator(sel('conflictCard'))).toHaveCount(0)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('conc.md')).not.toContain('Paragraph 05')
  await expect(page.locator('#mdr-editor-host')).not.toContainText('Paragraph 05')
})

test.describe('rail-ui 7: the composer scrolls the document only as far as it takes', () => {
  for (const [w, h, y] of [[1440, 900, 810], [800, 507, 405]] as const) {
    test(`${w}x${h}: a word ${y}px down scrolls well under a screen, and the word stays on screen`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: h })
      await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(36) })
      await scrollTextTo(page, 'marker14x', y)
      await selectText(page, { from: 'marker14x', reveal: false })
      const before = await scrollTop(page)
      const selTopBefore = await textTop(page, 'marker14x')
      // the dock hangs over the foot of the rail's column: the card has to clear it too (T2 review round 2)
      const dockH = (await page.locator(sel('docComposer')).boundingBox())!.height + 8
      await page.locator(sel('floatingComment')).click()
      const draft = page.locator('[data-draft="true"]')
      await expect(draft).toBeVisible()
      await railSettled(page)
      const after = await scrollTop(page)
      // the card is ~145px tall: a margin and its overhang (and the dock's room), never a jump of hundreds of pixels
      expect(after - before, `scrolled ${after - before}px`).toBeLessThanOrEqual(190 + dockH)
      expect(after - before).toBeGreaterThanOrEqual(0)
      // the text being commented is still where TJ can read it
      const selTopAfter = await textTop(page, 'marker14x')
      expect(selTopAfter).toBeGreaterThan(40)
      expect(selTopBefore - selTopAfter).toBeLessThanOrEqual(190 + dockH)
      // and the composer is fully on screen with the caret in it
      const box = await draft.boundingBox()
      expect(box!.y + box!.height).toBeLessThanOrEqual(h + 0.5)
      await expect(draft.locator('textarea')).toBeFocused()
    })
  }

  test('a selection near the top does not scroll at all', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(36) })
    await scrollTextTo(page, 'marker14x', 200)
    await selectText(page, { from: 'marker14x', reveal: false })
    const before = await scrollTop(page)
    await page.locator(sel('floatingComment')).click()
    await expect(page.locator('[data-draft="true"]')).toBeVisible()
    await railSettled(page)
    expect(await scrollTop(page)).toBe(before)
  })
})

test.describe('rail-ui 6: Claude replying under the box TJ is typing in', () => {
  for (const [w, h, y] of [[1440, 900, 675], [800, 507, 280]] as const) {
    test(`${w}x${h}: the focused reply box stays on screen and keeps what was typed`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: h })
      await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(36) })
      const made = await claude(server, 'rail.md', [{ op: 'comment', quote: 'marker14x', body: 'Is this still right?' }])
      const thread = made.results[0]!.thread!
      const card = page.locator(sel('card', `[data-thread="${thread}"]`))
      await expect(card).toHaveCount(1)
      await scrollTextTo(page, 'marker14x', y)
      await railSettled(page)
      await page.locator(sel('highlight', `[data-thread="${thread}"]`)).first().click()
      const box = card.locator('textarea')
      await box.click()
      await page.keyboard.type('Half a sentence about the')
      const before = await scrollTop(page)
      await claude(server, 'rail.md', [{ op: 'reply', thread: thread as never, body: 'One.\nTwo.\nThree.\nFour.\nFive lines of answer so the card grows well past the box.' }])
      await expect(card.locator(sel('message'))).toHaveCount(2, { timeout: 15_000 })
      await railSettled(page)
      // the box TJ is typing in is still entirely on screen
      const r = (await box.boundingBox())!
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.y + r.height, `box bottom ${r.y + r.height} vs window ${h}`).toBeLessThanOrEqual(h + 0.5)
      // by a nudge, not a jump
      expect(Math.abs((await scrollTop(page)) - before)).toBeLessThan(400)
      // he keeps typing into it, and nothing he typed was lost
      await expect(box).toBeFocused()
      await page.keyboard.type(' next line.')
      await expect(box).toHaveValue('Half a sentence about the next line.')
    })
  }
})

const WORDS = ['alpha1x', 'bravo2x', 'charlie3x', 'delta4x', 'echo5x', 'foxtrot6x', 'golf7x', 'hotel8x', 'india9x', 'juliet10x', 'kilo11x', 'lima12x']
const DENSE = `# Dense\n\n${WORDS.join(' ')} and a short tail.\n\nA second paragraph below it.\n`

test.describe('rail-ui 8: hovering a collapsed card never covers its neighbours', () => {
  for (const [w, h] of [[1440, 900], [800, 700]] as const) {
    test(`${w}x${h}: moving the mouse down a dense cluster reaches every card in order`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: h })
      await openDoc(page, { port: server.port, tmpRoot, file: 'dense.md', content: DENSE })
      await claude(server, 'dense.md', WORDS.map((q) => ({ op: 'comment' as const, quote: q, body: `About ${q}, which has a longer note so the card has more to show when it opens.` })))
      await expect(page.locator(sel('card'))).toHaveCount(12, { timeout: 15_000 })
      await railSettled(page, 400)
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="mdr-card"]')]
          .map((e) => ({ id: e.dataset.thread!, top: e.getBoundingClientRect().top, left: e.getBoundingClientRect().left, width: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, collapsed: e.dataset.collapsed }))
          .sort((a, b) => a.top - b.top),
      )
      expect(rows.every((r) => r.collapsed === 'true'), JSON.stringify(rows)).toBe(true)
      const x = rows[0]!.left + rows[0]!.width / 2
      // start on the third card's footprint, then walk down in 4px steps across the next three
      const start = rows[2]!.top + 8
      const end = rows[5]!.top + rows[5]!.h - 4
      const seen: string[] = []
      for (let y = start; y <= end; y += 4) {
        await page.mouse.move(x, y)
        const id = await page.evaluate(() => (document.querySelector('[data-testid="mdr-card"]:hover') as HTMLElement | null)?.dataset.thread ?? '')
        if (id && seen.at(-1) !== id) seen.push(id)
      }
      expect(seen).toEqual(rows.slice(2, 6).map((r) => r.id))
    })
  }

  test('in a dense cluster the hovered card stays one line (no room), and nothing is drawn over its neighbours', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'dense.md', content: DENSE })
    await claude(server, 'dense.md', WORDS.map((q) => ({ op: 'comment' as const, quote: q, body: `About ${q}, which has a longer note so the card has more to show when it opens.` })))
    await expect(page.locator(sel('card'))).toHaveCount(12, { timeout: 15_000 })
    await railSettled(page, 400)
    const card = page.locator(sel('card')).nth(4)
    const before = (await card.boundingBox())!
    await page.mouse.move(before.x + before.width / 2, before.y + 8)
    await railSettled(page, 200)
    const after = (await card.boundingBox())!
    expect(after.height).toBeLessThanOrEqual(before.height + 12)
    // the point just under it is the next card, whole
    const probe = await page.evaluate(([cx, cy]) => (document.elementFromPoint(cx as number, cy as number) as HTMLElement | null)?.closest<HTMLElement>('[data-testid="mdr-card"]')?.dataset.thread ?? '', [before.x + before.width / 2, before.y + before.height + 12] as const)
    expect(probe).not.toBe('')
    expect(probe).not.toBe(await card.getAttribute('data-thread'))
    await shot(page, 'f8-hover-dense')
  })

  test('a collapsed card with free space below it still opens on hover, and its Accept can be clicked', async ({ page, server, tmpRoot }) => {
    // a comment and a suggestion a line apart: the suggestion's card is pushed down by the comment's and folds; nothing is below it
    await openDoc(page, { port: server.port, tmpRoot, file: 'two.md', content: '# Two\n\nThe member rate of 12% is paid monthly. We launch in Q3.\n\nTail.\n' })
    const made = await claude(server, 'two.md', [
      { op: 'comment', quote: 'member rate of 12%', body: 'Is 12% still current? A long enough question that the first card is tall.' },
      { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q3 2026.', reason: 'Name the year.' },
    ])
    const sug = page.locator(sel('card', `[data-thread="${made.results[1]!.thread}"]`))
    await expect(sug).toHaveAttribute('data-collapsed', 'true', { timeout: 15_000 })
    await railSettled(page, 300)
    const closed = (await sug.boundingBox())!
    await page.mouse.move(closed.x + closed.width / 2, closed.y + 8)
    await expect.poll(async () => (await sug.boundingBox())!.height).toBeGreaterThan(closed.height + 60)
    await shot(page, 'f8-hover-open-with-room')
    await sug.locator(sel('accept')).click()
    await expect(sug).toHaveCount(0, { timeout: 10_000 })
  })
})

test.describe('rail-ui 3 / 11: a crowded line near the top never hides cards behind "+N above"', () => {
  const comments = WORDS.map((q) => ({ op: 'comment' as const, quote: q, body: `About ${q}.` }))

  async function open(page: Page, server: { port: number; origin: string; token: string }, tmpRoot: Parameters<typeof openDoc>[1]['tmpRoot']) {
    await openDoc(page, { port: server.port, tmpRoot, file: 'dense.md', content: DENSE })
    const made = await claude(server, 'dense.md', comments)
    await expect(page.locator(sel('card'))).toHaveCount(12, { timeout: 15_000 })
    await railSettled(page, 400)
    return made.results.map((r) => r.thread!)
  }

  const visibleCards = (page: Page): Promise<Array<{ id: string; placed: string | undefined; vis: string; top: number; collapsed: string | undefined; active: string | undefined }>> =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="mdr-card"]:not([data-draft])')]
        .map((e) => ({ id: e.dataset.thread!, placed: e.dataset.placed, vis: getComputedStyle(e).visibility, top: e.getBoundingClientRect().top, collapsed: e.dataset.collapsed, active: e.dataset.active }))
        .sort((a, b) => a.top - b.top),
    )

  for (const [w, h] of [[1440, 900], [800, 700]] as const) {
    test(`${w}x${h}: activating any card keeps all twelve placed and visible, in document order`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: h })
      const ids = await open(page, server, tmpRoot)
      const hl = (i: number) => page.locator(sel('highlight', `[data-thread="${ids[i]}"]`)).first()
      for (const i of [2, 6, 9, 11, 0]) {
        await hl(i).click()
        await railSettled(page, 300)
        const cards = await visibleCards(page)
        expect(cards.map((c) => c.placed), `after clicking highlight ${i + 1}`).toEqual(Array(12).fill('true'))
        expect(cards.every((c) => c.vis === 'visible')).toBe(true)
        // still in document order, none above the header, the clicked one open
        expect(cards.map((c) => c.id)).toEqual(ids)
        expect(cards.find((c) => c.id === ids[i])).toMatchObject({ active: 'true', collapsed: 'false' })
        await expect(page.locator(sel('overflowChip'))).toBeHidden()
      }
      await shot(page, `f3-dense-${w}`)
    })
  }

  test('a new comment on the crowded line leaves the other cards where they are visible, and the draft too', async ({ page, server, tmpRoot }) => {
    const ids = await open(page, server, tmpRoot)
    await selectText(page, { from: 'tail', reveal: false })
    await page.locator(sel('floatingComment')).click()
    const draft = page.locator('[data-draft="true"]')
    await expect(draft).toBeVisible()
    await railSettled(page, 300)
    const cards = await visibleCards(page)
    expect(cards.map((c) => c.placed)).toEqual(Array(12).fill('true'))
    expect(cards.map((c) => c.id)).toEqual(ids)
    await expect(page.locator(sel('overflowChip'))).toBeHidden()
    await expect(draft.locator('textarea')).toBeFocused()
    await shot(page, 'f11-draft-on-crowded-line')
  })
})

test('rail-ui 2: clicking Claude’s tracked change inside a commented sentence opens the suggestion’s card', async ({ page, server, tmpRoot }) => {
  const S = 'Distributions are intended monthly after a two-year lock.'
  await openDoc(page, { port: server.port, tmpRoot, file: 'terms.md', content: `# Terms\n\n${S}\n\nAnother paragraph, far from it.\n` })
  const made = await claude(server, 'terms.md', [
    { op: 'comment', quote: S, body: 'Is the lock period right?' },
    { op: 'suggest', quote: 'two-year lock', replace: '24-month lock', reason: 'fix' },
  ])
  const commentThread = made.results[0]!.thread!
  const suggThread = made.results[1]!.thread!
  await expect(page.locator(sel('card'))).toHaveCount(2, { timeout: 15_000 })
  await railSettled(page, 300)
  for (const part of ['ins', 'del'] as const) {
    // from the comment's card to the tracked change: its own card takes over
    await page.locator(sel('card', `[data-thread="${commentThread}"]`)).click({ position: { x: 20, y: 10 } })
    await expect(page.locator(sel('card', `[data-thread="${commentThread}"]`))).toHaveAttribute('data-active', 'true')
    await page.locator(`.mdr-sugg[data-kind="${part}"]`).first().click()
    await expect(page.locator(sel('card', `[data-thread="${suggThread}"]`))).toHaveAttribute('data-active', 'true')
    await expect(page.locator(sel('card', `[data-thread="${commentThread}"]`))).toHaveAttribute('data-active', 'false')
  }
  await shot(page, 'f2-overlap-click')
  // a click on the commented words before the change is still the comment
  await page.getByText('Distributions are intended', { exact: false }).first().click({ position: { x: 20, y: 8 } })
  await expect(page.locator(sel('card', `[data-thread="${commentThread}"]`))).toHaveAttribute('data-active', 'true')
})

/** What Claude would read from `mdr pending` right now. */
async function pending(server: { origin: string; token: string }, file: string): Promise<{ counts: Record<string, number>; threads: Array<{ id: string; messages?: Array<{ body: string; by: string }> }> }> {
  const r = await fetch(`${server.origin}/api/agent/pending?file=${encodeURIComponent(file)}`, { headers: agentHeaders({ token: server.token }) })
  return (await r.json()) as never
}

test.describe('rail-ui 5: Send to Claude with something typed but not posted', () => {
  test('a reply in the box is posted first, so Claude’s pending list has it', async ({ page, server, tmpRoot }) => {
    await installClipboard(page)
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
    const made = await claude(server, 'rail.md', [{ op: 'comment', quote: 'marker3x', body: 'Is this still right?' }])
    const thread = made.results[0]!.thread!
    const card = page.locator(sel('card', `[data-thread="${thread}"]`))
    await expect(card).toHaveCount(1)
    await page.locator(sel('highlight', `[data-thread="${thread}"]`)).first().click()
    await card.locator('textarea').click()
    await page.keyboard.type('Unposted reply draft')
    await page.locator(sel('send')).click()
    await expect
      .poll(() => (tmpRoot.readSidecar('rail.md') as Array<{ type?: string; body?: string; by?: string }>).filter((e) => e.type === 'comment.reply' && e.body === 'Unposted reply draft' && e.by === 'TJ').length)
      .toBe(1)
    await expect(card.locator(sel('message'))).toHaveCount(2)
    await expect(card.locator('textarea')).toHaveValue('')
    const p = await pending(server, 'rail.md')
    expect(p.counts.messages).toBeGreaterThanOrEqual(1)
  })

  test('a new-comment draft is posted by Send too', async ({ page, server, tmpRoot }) => {
    await installClipboard(page)
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
    await selectText(page, { from: 'marker3x' })
    await page.locator(sel('floatingComment')).click()
    // the box takes the focus after the layout frame that places its card (§11.4); typing before that lands in the
    // document, over the selected word (the file got 'note that was never posted' and 'marker3x' became 'A')
    await expect(page.locator('[data-draft="true"] textarea')).toBeFocused()
    await page.keyboard.type('A note that was never posted')
    await page.locator(sel('send')).click()
    await expect
      .poll(() => (tmpRoot.readSidecar('rail.md') as Array<{ type?: string; body?: string }>).filter((e) => e.type === 'comment.add' && e.body === 'A note that was never posted').length)
      .toBe(1)
    await expect(page.locator('[data-draft="true"]')).toHaveCount(0)
    expect((await pending(server, 'rail.md')).counts.threads).toBeGreaterThanOrEqual(1)
  })
})

test.describe('rail-ui 9: focus after a composer closes', () => {
  const open = async (page: Page, server: { port: number }, tmpRoot: Parameters<typeof openDoc>[1]['tmpRoot']) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
    await selectText(page, { from: 'marker3x' })
    await page.locator(sel('floatingComment')).click()
    await expect(page.locator('[data-draft="true"] textarea')).toBeFocused()
  }
  const inEditor = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('.ProseMirror'))

  for (const [name, finish] of [
    ['Cmd+Enter', async (page: Page) => page.keyboard.press('Meta+Enter')],
    ['the Comment button', async (page: Page) => page.locator('[data-draft="true"]').locator(sel('cardSubmit')).click()],
    ['Cancel', async (page: Page) => page.locator('[data-draft="true"] button[aria-label="Cancel"]').click()],
    ['Esc', async (page: Page) => page.keyboard.press('Escape')],
  ] as const) {
    test(`${name}: the next keystrokes go to the document`, async ({ page, server, tmpRoot }) => {
      await open(page, server, tmpRoot)
      await page.keyboard.type('Needs a number')
      if (name === 'Cancel' || name === 'Esc') await page.locator('[data-draft="true"] textarea').fill('')
      await finish(page)
      await expect(page.locator('[data-draft="true"]')).toHaveCount(0, { timeout: 10_000 })
      expect(await inEditor(page)).toBe(true)
      // typing lands in the file, not nowhere; after a post it must not replace the words that were just commented on
      await page.keyboard.type('QQQ')
      const after = await page.locator('#mdr-editor-host').innerText()
      expect(after).toContain('QQQ')
      if (name === 'Cmd+Enter' || name === 'the Comment button') expect(after.replace('QQQ', '')).toContain('marker3x')
    })
  }

  test('Esc in a reply box, and the Reply button, keep typing possible', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
    const made = await claude(server, 'rail.md', [{ op: 'comment', quote: 'marker3x', body: 'Is this right?' }])
    const thread = made.results[0]!.thread!
    const card = page.locator(sel('card', `[data-thread="${thread}"]`))
    await page.locator(sel('highlight', `[data-thread="${thread}"]`)).first().click()
    const box = card.locator('textarea')
    await box.click()
    await page.keyboard.type('one')
    await card.locator(sel('cardSubmit')).click()
    await expect(card.locator(sel('message'))).toHaveCount(2)
    await expect(box).toBeFocused()
    await page.keyboard.type('two')
    await page.keyboard.press('Escape')
    expect(await inEditor(page)).toBe(true)
  })
})

test('rail-ui 10: Claude resolving the thread TJ is mid-reply in keeps the card and the draft', async ({ page, server, tmpRoot }) => {
  await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
  const made = await claude(server, 'rail.md', [{ op: 'comment', quote: 'marker3x', body: 'Is this right?' }])
  const thread = made.results[0]!.thread!
  const card = page.locator(sel('card', `[data-thread="${thread}"]`))
  await page.locator(sel('highlight', `[data-thread="${thread}"]`)).first().click()
  const box = card.locator('textarea')
  await box.click()
  await page.keyboard.type('Half a sentence about the')
  await claude(server, 'rail.md', [{ op: 'resolve', thread: thread as never }])
  await expect(page.locator(sel('showResolved'))).toContainText('(1)', { timeout: 15_000 })
  await railSettled(page, 300)
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Resolved')
  await expect(box).toBeFocused()
  // the card grew a tag and a Reopen button under it: the box he is typing in is still on screen
  const r = (await box.boundingBox())!
  expect(r.y + r.height).toBeLessThanOrEqual(900.5)
  await page.keyboard.type(' next words')
  await expect(box).toHaveValue('Half a sentence about the next words')
  await shot(page, 'f10-resolved-under-typing')
})

test('rail-ui 12: the Claude badge reveals a resolved thread that holds the unread reply', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
  const made = await claude(server, 'rail.md', [{ op: 'comment', quote: 'marker3x', body: 'Is this right?' }])
  const thread = made.results[0]!.thread!
  await expect(page.locator(sel('card', `[data-thread="${thread}"]`))).toHaveCount(1)
  // TJ replies (so Claude owes an answer), then Claude answers and resolves its own thread in one batch
  await page.locator(sel('highlight', `[data-thread="${thread}"]`)).first().click()
  await page.locator(sel('card', `[data-thread="${thread}"]`)).locator('textarea').click()
  await page.keyboard.type('Yes, still right.')
  await page.keyboard.press('Meta+Enter')
  await expect(page.locator(sel('card', `[data-thread="${thread}"]`)).locator(sel('message'))).toHaveCount(2)
  await page.mouse.click(10, 300)
  await claude(server, 'rail.md', [
    { op: 'reply', thread: thread as never, body: 'Thanks, noted.' },
    { op: 'resolve', thread: thread as never },
  ])
  await expect(page.locator(sel('card', `[data-thread="${thread}"]`))).toHaveCount(0, { timeout: 15_000 })
  const unread = page.locator(sel('claudeBadge')).locator(sel('badgeAction'))
  await expect(unread).toBeVisible({ timeout: 15_000 })
  await unread.click()
  await expect(page.locator(sel('showResolved'))).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator(sel('card', `[data-thread="${thread}"]`))).toHaveAttribute('data-active', 'true')
  // opening it read it: the count does not stay on the badge with nothing to show for it
  await expect.poll(() => ed.session((s) => s.getReview().activity.unreadFromClaude), { timeout: 15_000 }).toBe(0)
})

test('rail-ui 15: an empty document says what to do, and Previous/Next wait for a comment', async ({ page, server, tmpRoot }) => {
  await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(6) })
  const hint = page.locator('.mdr-rail-hint')
  await expect(hint).toContainText('Select text to comment.')
  await expect(hint).toContainText('Switch to Suggesting to propose edits.')
  await expect(hint).toContainText('Click Send to Claude')
  await expect(hint).toBeVisible()
  await expect(page.locator(sel('navPrev'))).toBeDisabled()
  await expect(page.locator(sel('navNext'))).toBeDisabled()
  await shot(page, 'f15-empty-rail')
  await claude(server, 'rail.md', [{ op: 'comment', quote: 'marker3x', body: 'First comment.' }])
  await expect(page.locator(sel('card'))).toHaveCount(1, { timeout: 15_000 })
  await expect(hint).toHaveCount(0)
  await expect(page.locator(sel('navNext'))).toBeEnabled()
})

test.describe('rail-ui 16: big actions say what they did and offer Undo', () => {
  test('Resolve: a toast with Undo, and "Show resolved (1)" so the thread can be found again', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
    const made = await claude(server, 'rail.md', [{ op: 'comment', quote: 'marker3x', body: 'Is this right?' }])
    const thread = made.results[0]!.thread!
    const card = page.locator(sel('card', `[data-thread="${thread}"]`))
    await expect(page.locator(sel('showResolved'))).toHaveText('Show resolved')
    await card.locator(sel('cardResolve')).click()
    const toast = page.locator(sel('toast', { 'data-code': 'THREAD_RESOLVED' }))
    await expect(toast).toContainText('Comment resolved.')
    await expect(card).toHaveCount(0)
    await expect(page.locator(sel('showResolved'))).toContainText('Show resolved (1)')
    await shot(page, 'f16-resolved-toast')
    await toast.locator(sel('toastAction')).click()
    await expect(card).toHaveCount(1)
    await expect(page.locator(sel('showResolved'))).toHaveText('Show resolved')
  })

  test('Accept all from Claude: "Accepted 2 changes." with an Undo that brings them back', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
    await claude(server, 'rail.md', [
      { op: 'suggest', quote: 'Paragraph 2 talks', replace: 'Paragraph two covers' },
      { op: 'suggest', quote: 'Paragraph 5 talks', replace: 'Paragraph five covers' },
    ])
    await expect(page.locator(sel('card'))).toHaveCount(2, { timeout: 15_000 })
    await page.locator(sel('acceptAllClaude')).click()
    const toast = page.locator(sel('toast', { 'data-code': 'DECISIONS_APPLIED' }))
    await expect(toast).toContainText('Accepted 2 changes.')
    await expect(page.locator(sel('card'))).toHaveCount(0)
    await toast.locator(sel('toastAction')).click()
    await expect(page.locator(sel('card'))).toHaveCount(2, { timeout: 10_000 })
  })

  test('Delete table: a toast with Undo; the toolbar has Undo and Redo', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: '# T\n\n| A | B |\n| - | - |\n| a1 | b1 |\n\nAfter the table.\n' })
    await page.getByText('a1', { exact: true }).click()
    await page.locator(sel('tableAction', '[data-action="table-delete"]')).click()
    const toast = page.locator(sel('toast', { 'data-code': 'TABLE_DELETED' }))
    await expect(toast).toContainText('Table deleted.')
    await expect(page.locator('#mdr-editor-host table')).toHaveCount(0)
    await toast.locator(sel('toastAction')).click()
    await expect(page.locator('#mdr-editor-host table')).toHaveCount(1)
    // the toolbar's own Undo / Redo
    const undo = page.locator(sel('toolbarButton', { 'data-action': 'undo' }))
    const redo = page.locator(sel('toolbarButton', { 'data-action': 'redo' }))
    await expect(undo).toBeVisible()
    await redo.click()
    await expect(page.locator('#mdr-editor-host table')).toHaveCount(0)
    await undo.click()
    await expect(page.locator('#mdr-editor-host table')).toHaveCount(1)
  })
})

test('rail-ui 14: the policy switch explains itself', async ({ page, server, tmpRoot }) => {
  await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(6) })
  const sw = page.locator(sel('policyToggle'))
  await expect(sw).toHaveAttribute('title', /On: Claude can change the text itself\. Off: Claude can only suggest changes for you to accept\./)
  await expect(sw).toHaveAccessibleDescription(/Off: Claude can only suggest changes/)
})

test('rail-ui 4: cards created bottom-up read top-down in the DOM and in the Tab order', async ({ page, server, tmpRoot }) => {
  await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
  await claude(server, 'rail.md', [5, 4, 3, 2, 1].map((n) => ({ op: 'comment' as const, quote: `marker${n}x`, body: `Note on ${n}` })))
  await expect(page.locator(sel('card'))).toHaveCount(5, { timeout: 15_000 })
  await railSettled(page, 300)
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="mdr-card"]')].map((e) => ({ body: e.textContent ?? '', top: e.getBoundingClientRect().top })),
  )
  expect(rows.map((r) => r.body.match(/Note on (\d)/)![1])).toEqual(['1', '2', '3', '4', '5'])
  expect(rows.map((r) => r.top)).toEqual([...rows.map((r) => r.top)].sort((a, b) => a - b))
})

test('rail-ui 1 / 4: at 600px the sheet lists cards in document order, and a folded card shows Claude’s reply and a count', async ({ page, server, tmpRoot }) => {
  await page.setViewportSize({ width: 600, height: 800 })
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'rail.md', content: railDoc(12) })
  const byMarker: Record<number, string> = {}
  for (const n of [5, 4, 3, 2, 1]) {
    // TJ comments bottom-up, so creation order is the reverse of document order
    await placeCaret(page, `marker${n}x`, 'select')
    const target = await ed.bridge((b) => b.getSelectionTarget())
    if (target?.kind !== 'anchor') throw new Error('no anchor target')
    const r = await ed.session((sess, a) => sess.createThread(a.anchor, a.body), { anchor: target.anchor, body: `Should marker ${n} say net returns instead?` })
    byMarker[n] = r.thread.id
  }
  await claude(server, 'rail.md', [{ op: 'reply', thread: byMarker[3] as never, body: 'Yes, switching to net returns everywhere except the footnote.' }])
  await page.locator(sel('sheetToggle')).click()
  const sheet = page.locator(sel('sheet'))
  await expect(sheet.locator(sel('card'))).toHaveCount(5)
  await expect(sheet.locator(sel('card', { 'data-thread': byMarker[3]! }))).toContainText('1 reply', { timeout: 15_000 })
  const cards = await sheet.locator(sel('card')).evaluateAll((els) => els.map((e) => ({ id: (e as HTMLElement).dataset.thread!, preview: e.querySelector('.mdr-card-preview')?.textContent ?? '', replies: e.querySelector('.mdr-card-replies')?.textContent ?? '' })))
  expect(cards.map((c) => c.id)).toEqual([1, 2, 3, 4, 5].map((n) => byMarker[n]))
  const three = cards.find((c) => c.id === byMarker[3])!
  expect(three.preview).toBe('Claude: Yes, switching to net returns everywhere except the footnote.')
  expect(three.replies).toBe('1 reply')
  expect(cards.filter((c) => c.replies !== '').length).toBe(1)
  await shot(page, 'f1-sheet-600')
})
