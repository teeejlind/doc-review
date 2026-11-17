// tests/e2e/t2-editor-ux-link.spec.ts (T2 editor-ux): Pass 4 #19 and #20, the Cmd+K link popover in a real window.
//   #19 near the bottom of the window the popover opens above the selection, with the field, Apply and Cancel on screen.
//   #20 a bare word or a phrase is refused in plain words and nothing is saved; a bare domain becomes https://.
import type { Page } from '@playwright/test'
import { TESTID } from '../../shared/constants'
import { browserChoice } from '../helpers/browser'
import { MOD, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const filler = (n: number): string => Array.from({ length: n }, (_, i) => `Filler paragraph number ${i + 1} keeps the page long enough to scroll.`).join('\n\n')
const DOC = `${filler(14)}\n\nThe portfolio page is the one to read.\n\n${filler(14)}\n`

const popover = (page: Page) => page.locator(`[data-testid="${TESTID.linkPopover}"]`)
const action = (page: Page, name: string) => popover(page).locator(`[data-testid="${TESTID.popoverAction}"][data-action="${name}"]`)
const field = (page: Page) => popover(page).locator(`[data-testid="${TESTID.popoverField}"][data-field="url"]`)

/** Scroll the page so the line holding `text` ends `fromBottom` px above the bottom of the window. */
async function putNearBottom(page: Page, text: string, fromBottom: number): Promise<void> {
  await page.evaluate(([t, gap]) => {
    const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').indexOf(t as string)
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + (t as string).length)
      const bottom = r.getBoundingClientRect().bottom
      document.querySelector<HTMLElement>('#mdr-scroll')!.scrollTop += bottom - (innerHeight - (gap as number))
      return
    }
  }, [text, fromBottom] as const)
}

test('#19: a selection near the bottom of the window gets its popover above it, buttons on screen', async ({ page, server, tmpRoot }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: DOC })
  await placeCaret(page, 'portfolio page', 'select')
  await putNearBottom(page, 'portfolio page', 24)
  const selection = await page.evaluate(() => {
    const r = getSelection()!.getRangeAt(0).getBoundingClientRect()
    return { top: r.top, bottom: r.bottom }
  })
  expect(selection.bottom).toBeGreaterThan(740)
  await page.keyboard.press(`${MOD}+KeyK`)
  await expect(popover(page)).toBeVisible()
  const box = (await popover(page).boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(800)
  expect(box.y + box.height).toBeLessThanOrEqual(selection.top + 1) // above the selected line
  await expect(field(page)).toBeInViewport({ ratio: 1 })
  await expect(action(page, 'apply')).toBeInViewport({ ratio: 1 })
  await expect(action(page, 'cancel')).toBeInViewport({ ratio: 1 })
  // and it still works from there
  await field(page).fill('example.com')
  await action(page, 'apply').click()
  await expect(popover(page)).toHaveCount(0)
})

test('#19: higher up the window it still opens below the selection, as before', async ({ page, server, tmpRoot }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: DOC })
  await placeCaret(page, 'portfolio page', 'select')
  await putNearBottom(page, 'portfolio page', 500)
  const selection = await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().bottom)
  await page.keyboard.press(`${MOD}+KeyK`)
  const box = (await popover(page).boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(selection)
  await expect(action(page, 'apply')).toBeInViewport({ ratio: 1 })
})

test('#20: "example" and "hello world" are refused in plain words and nothing is saved', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: 'Read the portfolio page today.\n' })
  await placeCaret(page, 'portfolio page', 'select')
  await page.keyboard.press(`${MOD}+KeyK`)
  for (const bad of ['example', 'hello world']) {
    await field(page).fill(bad)
    await page.keyboard.press('Enter')
    await expect(popover(page)).toBeVisible()
    await expect(popover(page).getByRole('alert')).toHaveText('Enter a web address, like example.com.')
  }
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Read the portfolio page today.\n')
  // the same popover takes a good address
  await field(page).fill('example.com')
  await page.keyboard.press('Enter')
  await expect(popover(page)).toHaveCount(0)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Read the [portfolio page](https://example.com) today.\n')
})

test('#20: web, mailto, #section and relative addresses all go in', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: 'Read the portfolio page today.\n' })
  for (const [typed, saved] of [
    ['https://example.com/a', 'https://example.com/a'],
    ['mailto:ana@example.com', 'mailto:ana@example.com'],
    ['#goals', '#goals'],
    ['./notes.md', './notes.md'],
    ['www.example.com', 'https://www.example.com'],
  ] as const) {
    await placeCaret(page, 'portfolio page', 'select')
    await page.keyboard.press(`${MOD}+KeyK`)
    await field(page).fill(typed)
    await page.keyboard.press('Enter')
    await expect(popover(page)).toHaveCount(0)
    expect(await savedText(ed, tmpRoot, 'k.md')).toBe(`Read the [portfolio page](${saved}) today.\n`)
  }
})
