// tests/e2e/t2-rail-minors.spec.ts (QA pass 4 rail minors #10, #11, #16, #18, #25, and the reveal rule they share).
//
// Each case is the finding's own repro, driven in a real browser against the real server.
import type { Page } from '@playwright/test'
import { claude, openDoc } from './fixtures/p2'
import { openRailSettings, railDoc, railSettled, selectText, sel } from './fixtures/p3'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const scrollTo = (page: Page, to: number): Promise<void> =>
  page.evaluate((y) => {
    document.getElementById('mdr-scroll')!.scrollTop = y
  }, to)
const scrollTop = (page: Page): Promise<number> => page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)

test.describe('a composer scrolled out of view stays out of view', () => {
  test('Claude replying in the thread TJ was typing in does not pull the document back up to the reply box', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: railDoc(60) })
    const made = await claude(server, 'long.md', [{ op: 'comment', quote: 'marker2x', body: 'Which borrower is this?' }])
    const thread = made.results[0]!.thread!
    await page.locator(sel('highlight', { 'data-thread': thread })).first().click()
    const card = page.locator(sel('card', { 'data-thread': thread }))
    await card.locator('textarea').click()
    await page.keyboard.type('Half a reply')
    await railSettled(page, 100)
    // scroll away: the card, and the box in it, are above the window now (the pill is the way back)
    await scrollTo(page, 2400)
    await railSettled(page, 100)
    await expect(page.locator(sel('offscreenPill'))).toBeVisible()
    const at = await scrollTop(page)
    await claude(server, 'long.md', [{ op: 'reply', thread, body: 'A reply that makes the card taller. '.repeat(12) }])
    await expect(card.locator(sel('message'))).toHaveCount(2)
    await railSettled(page, 400)
    expect(await scrollTop(page)).toBe(at)
    // the draft is still there, ready for the pill to take him back to it
    await expect(card.locator('textarea')).toHaveValue('Half a reply')
  })
})

test.describe('#10 an open new-comment card stays with its text', () => {
  test('Claude inserting a paragraph above the selection moves the card with the words, not the other way round', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: railDoc(30) })
    await selectText(page, { from: 'marker8x' })
    await page.locator(sel('floatingComment')).click()
    await expect(page.locator('[data-draft="true"] textarea')).toBeFocused()
    await page.keyboard.type('A half-written comment')
    await railSettled(page, 150)
    // the card's top and the draft highlight's top, in the window
    const gap = (): Promise<number> =>
      page.evaluate(() => {
        const card = document.querySelector('[data-draft="true"]')!.getBoundingClientRect().top
        const hl = document.querySelector('[data-draft-highlight="true"]')!.getBoundingClientRect().top
        return Math.round(card - hl)
      })
    expect(Math.abs(await gap())).toBeLessThanOrEqual(2)
    await claude(server, 'long.md', [
      { op: 'insert_after', target: { quote: 'A short opening paragraph that sets things up' }, markdown: 'An inserted paragraph from Claude with enough words in it to take two or three lines at this width, so that every anchor below it moves down by a good amount.' },
    ])
    await expect(page.locator('#mdr-editor-host').getByText('An inserted paragraph from Claude')).toBeVisible({ timeout: 10_000 })
    await railSettled(page, 400)
    // whatever the browser did with its scroll anchoring, the card is still level with the words it is about
    expect(Math.abs(await gap())).toBeLessThanOrEqual(2)
    await expect(page.locator('[data-draft="true"] textarea')).toHaveValue('A half-written comment')
    // and the draft still posts on its words
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect.poll(() => page.locator(sel('card')).filter({ hasText: 'A half-written comment' }).count()).toBe(1)
  })
})

test.describe('#11 the off-screen pill gives the focus back to the reply box', () => {
  async function halfWrittenReply(page: Page, server: { origin: string; token: string; port: number }, tmpRoot: Parameters<typeof openDoc>[1]['tmpRoot']) {
    await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: railDoc(60) })
    const made = await claude(server, 'long.md', [{ op: 'comment', quote: 'marker2x', body: 'Which borrower is this?' }])
    const thread = made.results[0]!.thread!
    await page.locator(sel('highlight', { 'data-thread': thread })).first().click()
    const card = page.locator(sel('card', { 'data-thread': thread }))
    const box = card.locator('textarea')
    await box.click()
    await page.keyboard.type('A reply that is half written')
    await scrollTo(page, 1800)
    await railSettled(page, 100)
    const pill = page.locator(sel('offscreenPill'))
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-direction', 'up')
    return { box, pill }
  }

  test('a click on the pill takes him back to the card with the caret still in the box', async ({ page, server, tmpRoot }) => {
    const { box, pill } = await halfWrittenReply(page, server, tmpRoot)
    await pill.click()
    await railSettled(page, 150)
    await expect(pill).toBeHidden()
    await expect(box).toBeInViewport()
    await expect(box).toBeFocused()
    await page.keyboard.type(' and more')
    await expect(box).toHaveValue('A reply that is half written and more')
  })

  test('the pill pressed from the keyboard puts the caret at the end of the half-written reply', async ({ page, server, tmpRoot }) => {
    const { box, pill } = await halfWrittenReply(page, server, tmpRoot)
    await pill.focus()
    await page.keyboard.press('Enter')
    await railSettled(page, 150)
    await expect(pill).toBeHidden()
    await expect(box).toBeFocused()
    await page.keyboard.type('!')
    await expect(box).toHaveValue('A reply that is half written!')
  })

  test('with nothing typed, the keyboard press lands on the card, not on <body>', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: railDoc(60) })
    const made = await claude(server, 'long.md', [{ op: 'comment', quote: 'marker2x', body: 'Which borrower is this?' }])
    const thread = made.results[0]!.thread!
    await page.locator(sel('highlight', { 'data-thread': thread })).first().click()
    await scrollTo(page, 1800)
    await railSettled(page, 100)
    const pill = page.locator(sel('offscreenPill'))
    await expect(pill).toBeVisible()
    await pill.focus()
    await page.keyboard.press('Enter')
    await railSettled(page, 150)
    await expect(page.locator(sel('card', { 'data-thread': thread }))).toBeFocused()
  })
})

test.describe('#16 a resolved card’s head keeps the name and Reopen inside the card', () => {
  for (const width of [1280, 800]) {
    test(`${width} px: the name is whole, Reopen ends inside the card`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width, height: 800 })
      await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: railDoc(20) })
      const made = await claude(server, 'long.md', [{ op: 'comment', quote: 'marker2x', body: 'Which programs?' }])
      const thread = made.results[0]!.thread!
      await claude(server, 'long.md', [{ op: 'resolve', thread }])
      await openRailSettings(page)
      await page.locator(sel('showResolved')).click()
      await railSettled(page, 200)
      const card = page.locator(sel('card', { 'data-thread': thread }))
      await expect(card).toBeVisible()
      await expect(card.locator(sel('cardReopen'))).toBeVisible()
      const m = await card.evaluate((el) => {
        const box = (e: Element) => e.getBoundingClientRect()
        const author = el.querySelector<HTMLElement>('.mdr-card-author')!
        const label = el.querySelector<HTMLElement>('.mdr-card-label')!
        const head = el.querySelector<HTMLElement>('.mdr-card-head')!
        const reopen = el.querySelector<HTMLElement>('[data-testid="mdr-card-reopen"]')!
        return {
          authorText: author.textContent,
          authorWidth: box(author).width,
          authorClippedBy: Math.max(0, box(author).right - box(label).right),
          authorEllipsized: author.scrollWidth > author.clientWidth,
          reopenOverflow: Math.max(0, box(reopen).right - box(head).right),
          reopenClipped: reopen.scrollWidth > reopen.clientWidth,
          tag: !!el.querySelector('.mdr-card-tag') && getComputedStyle(el.querySelector('.mdr-card-tag')!).display !== 'none',
        }
      })
      expect(m.authorText).toBe('Claude')
      expect(m.authorWidth, 'the whole name').toBeGreaterThanOrEqual(55)
      expect(m.authorClippedBy).toBeLessThanOrEqual(0.5)
      expect(m.authorEllipsized).toBe(false)
      expect(m.reopenOverflow).toBeLessThanOrEqual(0.5)
      expect(m.reopenClipped).toBe(false)
      // the tag goes before the name does: it is there in the 300 px rail and not in the 240 px one
      expect(m.tag).toBe(width >= 1280)
    })
  }
})

test.describe('#18 the empty-rail hint follows the mode', () => {
  test('Editing offers Suggesting; Suggesting says edits are tracked as suggestions', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: railDoc(8) })
    const hint = page.locator('.mdr-rail-hint')
    await expect(hint).toContainText('Switch to Suggesting to propose edits.')
    await page.locator(sel('modePill')).click()
    await expect(hint).toContainText('Your edits are tracked as suggestions.')
    await expect(hint).not.toContainText('Switch to Suggesting')
    await expect(hint).toContainText('Click Send to Claude when you’re done.')
    await page.locator(sel('modePill')).click()
    await expect(hint).toContainText('Switch to Suggesting to propose edits.')
  })
})
