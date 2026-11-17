// tests/e2e/p2-links.spec.ts (P2; CONTRACTS §12.13 "Links", §12.15). Real keyboard in Chromium: Cmd+K add, edit and
// remove; insert with no selection; a refused javascript: link; Cmd+click opens; a Suggesting-mode link add yields a
// `format` suggestion summary and leaves the .md alone.
import { browserChoice } from '../helpers/browser'
import { MOD, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const FILE = 'links.md'

test('p2-links: Cmd+K adds, edits and removes a link; no-selection insert; javascript: refused', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: 'Read the primer today.\n\nSee:\n' })
  const pop = ed.testid('linkPopover')
  const field = (f: string): import('@playwright/test').Locator => pop.locator(`[data-testid="mdr-popover-field"][data-field="${f}"]`)
  const act = (a: string): import('@playwright/test').Locator => pop.locator(`[data-testid="mdr-popover-action"][data-action="${a}"]`)

  // add on a selection
  await placeCaret(page, 'primer', 'select')
  await page.keyboard.press(`${MOD}+KeyK`)
  await expect(pop).toBeVisible()
  await expect(field('text')).toHaveCount(0)
  await field('url').fill('javascript:alert(1)')
  await page.keyboard.press('Enter')
  await expect(pop.locator('[role="alert"]')).toContainText('allowed')
  await field('url').fill('https://example.com/primer')
  await page.keyboard.press('Enter')
  await expect(pop).toBeHidden()
  expect(await savedText(ed, tmpRoot, FILE)).toBe('Read the [primer](https://example.com/primer) today.\n\nSee:\n')

  // edit: caret inside the link → the view popover → Edit
  await placeCaret(page, 'prim', 'end')
  await page.keyboard.press(`${MOD}+KeyK`)
  await expect(pop.locator('.mdr-popover__url')).toHaveText('https://example.com/primer')
  await act('edit').click()
  await field('url').fill('https://example.com/primer-v2')
  await page.keyboard.press('Enter')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('Read the [primer](https://example.com/primer-v2) today.\n\nSee:\n')

  // remove through the view popover
  await placeCaret(page, 'prim', 'end')
  await page.keyboard.press(`${MOD}+KeyK`)
  await act('remove').click()
  expect(await savedText(ed, tmpRoot, FILE)).toBe('Read the primer today.\n\nSee:\n')

  // no selection: URL plus text
  await placeCaret(page, 'See:', 'end')
  await page.keyboard.press(`${MOD}+KeyK`)
  await field('url').fill('/decks/q3.pdf')
  await field('text').fill('the deck')
  await field('text').press('Enter')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('Read the primer today.\n\nSee:[the deck](/decks/q3.pdf)\n')
})

test('p2-links: Cmd+click opens the link; a plain click shows the view popover', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: 'Go to [the site](https://example.com) now.\n' })
  await page.evaluate(() => {
    const w = window as unknown as { __opened: unknown[]; open: (...a: unknown[]) => null }
    w.__opened = []
    w.open = (...a: unknown[]) => {
      w.__opened.push(a)
      return null
    }
  })
  const link = page.locator('#mdr-editor-host .ProseMirror a', { hasText: 'the site' })
  await link.click({ modifiers: [MOD] })
  expect(await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)).toEqual([['https://example.com', '_blank', 'noopener']])
  // past ProseMirror's double-click window, so the second click is a single click
  await page.waitForTimeout(700)
  await link.click()
  await expect(ed.testid('linkPopover')).toBeVisible()
  await expect(ed.testid('linkPopover').locator('[data-action="open"]')).toBeVisible()
})

test('p2-links: a Suggesting-mode link add is a format suggestion; the .md is untouched', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: 'Read the primer today.\n' })
  await ed.testid('modePill').click()
  await placeCaret(page, 'primer', 'select')
  await page.keyboard.press(`${MOD}+KeyK`)
  await ed.testid('linkPopover').locator('[data-field="url"]').fill('https://example.com/primer')
  await page.keyboard.press('Enter')
  const kinds = await ed.bridge((b) => [...b.getSuggestionSummaries().values()].map((s) => s.kind))
  expect(kinds).toContain('format')
  expect(await savedText(ed, tmpRoot, FILE)).toBe('Read the primer today.\n')
})
