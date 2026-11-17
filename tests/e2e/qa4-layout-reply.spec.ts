// tests/e2e/qa4-layout-reply.spec.ts (QA round 4, Pass 4 item #2 "reply and new-comment boxes grow past the window").
//
// While TJ types, a composer that grows keeps its whole box, Reply/Comment and Cancel included, in view; a Claude reply
// that lands in the active thread does the same. Each test is the failing repro first.
import type { Page } from '@playwright/test'
import { TESTID } from '../../shared/constants'
import { claude, openDoc } from './fixtures/p2'
import { railDoc, railSettled, selectText } from './fixtures/p3'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [] })

const FILE = 'rail.md'
const sel = (key: keyof typeof TESTID, extra = ''): string => `[data-testid="${TESTID[key]}"]${extra}`

/** Scroll so the line holding `text` sits `y` px below the top of the scroll box. */
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
      sc.scrollTop += r.getBoundingClientRect().top - sc.getBoundingClientRect().top - (at as number)
      return
    }
    throw new Error(`no text ${t}`)
  }, [text, y] as const)
  await railSettled(page, 50)
}

/** The composer's buttons are inside the window: the box's bottom and the actions row's bottom both fit, and nothing is cut. */
async function expectBoxInWindow(page: Page, box: import('@playwright/test').Locator, label: string): Promise<void> {
  const h = page.viewportSize()!.height
  const b = (await box.boundingBox())!
  const actions = (await box.locator('.mdr-composer-actions').boundingBox())!
  expect(actions.y, `${label}: buttons top`).toBeGreaterThanOrEqual(0)
  expect(actions.y + actions.height, `${label}: buttons bottom ${actions.y + actions.height} vs window ${h}`).toBeLessThanOrEqual(h + 0.5)
  expect(b.y + b.height, `${label}: box bottom vs window`).toBeLessThanOrEqual(h + 0.5)
}

test.describe('rail-ui 2: a reply box that grows while TJ types stays on screen with its buttons', () => {
  for (const [w, h, y] of [
    [1100, 800, 560],
    [1440, 900, 700],
  ] as const) {
    test(`${w}x${h}: typing three lines into Reply keeps Reply and Cancel in view`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: h })
      await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: railDoc(36) })
      const made = await claude(server, FILE, [{ op: 'comment', quote: 'marker14x', body: 'Is this still right?' }])
      const thread = made.results[0]!.thread!
      await scrollTextTo(page, 'marker14x', y)
      await railSettled(page)
      await page.locator(sel('highlight', `[data-thread="${thread}"]`)).first().click()
      const card = page.locator(sel('card', `[data-thread="${thread}"]`))
      const box = card.locator(sel('cardReply'))
      await box.click()
      await page.keyboard.type('First line of the answer,\nsecond line of the answer,\nthird line of the answer.')
      await railSettled(page)
      await expectBoxInWindow(page, card.locator('.mdr-composer'), `${w}x${h} reply`)
    })
  }

  test('1100x800: a Claude reply that lands under the box TJ is typing in keeps Reply and Cancel in view', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: railDoc(36) })
    const made = await claude(server, FILE, [{ op: 'comment', quote: 'marker14x', body: 'Is this still right?' }])
    const thread = made.results[0]!.thread!
    await scrollTextTo(page, 'marker14x', 420)
    await railSettled(page)
    await page.locator(sel('highlight', `[data-thread="${thread}"]`)).first().click()
    const card = page.locator(sel('card', `[data-thread="${thread}"]`))
    await card.locator(sel('cardReply')).click()
    await page.keyboard.type('Half a sentence about the')
    await claude(server, FILE, [
      { op: 'reply', thread: thread as never, body: 'One.\nTwo.\nThree.\nFour.\nFive lines of answer so the card grows well past the box.' },
    ])
    await expect(card.locator(sel('message'))).toHaveCount(2, { timeout: 15_000 })
    await railSettled(page)
    await expectBoxInWindow(page, card.locator('.mdr-composer'), 'reply arrived')
    await expect(card.locator(sel('cardReply'))).toBeFocused()
    await page.keyboard.type(' next line.')
    await expect(card.locator(sel('cardReply'))).toHaveValue('Half a sentence about the next line.')
  })

  test('1100x800: a new comment that grows while TJ types keeps Comment and Cancel in view', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: railDoc(36) })
    await scrollTextTo(page, 'marker14x', 680)
    await selectText(page, { from: 'marker14x', reveal: false })
    await page.locator(sel('floatingComment')).click()
    const draft = page.locator('[data-draft="true"]')
    await expect(draft).toBeVisible()
    await draft.locator('textarea').click()
    await page.keyboard.type('A new comment that runs\nover two lines,\nand a third one.')
    await railSettled(page)
    await expectBoxInWindow(page, draft.locator('.mdr-composer'), 'new comment')
  })
})
