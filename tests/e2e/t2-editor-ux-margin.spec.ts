// tests/e2e/t2-editor-ux-margin.spec.ts (T2 editor-ux, Pass 4 #26): a click on the page margin or gutter puts the caret at
// the nearest line, with a real mouse; typing still lands.
import type { Page } from '@playwright/test'
import { browserChoice } from '../helpers/browser'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const DOC = '# A title\n\nAlpha line of text.\n\nBeta line of text.\n\nGamma line of text.\n'

const inEditor = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('[data-testid="mdr-editor"]'))

/** Viewport box of the line holding `text` (the editor's text column is `box`). */
async function lineBox(page: Page, text: string): Promise<{ x: number; y: number; width: number; height: number; midY: number }> {
  return page.evaluate((t) => {
    const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    const p = [...root.querySelectorAll('p, h1')].find((e) => (e.textContent ?? '').includes(t))!
    const r = p.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, midY: r.y + r.height / 2 }
  }, text)
}

for (const [w, h] of [[1280, 900], [800, 700]] as const) {
  test(`#26: clicking the margin and the gutter puts the caret on the nearest line (${w}x${h})`, async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: w, height: h })
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: DOC })
    const beta = await lineBox(page, 'Beta line')
    expect(beta.x).toBeGreaterThan(8) // there is a margin to click in (20 px at 800 wide)

    // left of the line: its start
    await placeCaret(page, 'Gamma line', 'end')
    await page.mouse.click(4, beta.midY)
    expect(await inEditor(page)).toBe(true)
    await page.keyboard.type('L')
    // right of the line, in the gutter between the column and the rail: its end
    const right = (await page.locator('#mdr-editor-host .ProseMirror').boundingBox())!
    await page.mouse.click(right.x + right.width + 8, beta.midY)
    expect(await inEditor(page)).toBe(true)
    await page.keyboard.type('R')
    expect(await savedText(ed, tmpRoot, 'k.md')).toBe('# A title\n\nAlpha line of text.\n\nLBeta line of text.R\n\nGamma line of text.\n')
  })
}

test('#26: below the last line and above the first, the caret goes to the end and the start of the text', async ({ page, server, tmpRoot }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: DOC })
  const box = (await page.locator('#mdr-editor-host .ProseMirror').boundingBox())!
  await placeCaret(page, 'Beta line', 'end')
  // below the text box; the box fills the window when the doc is short, so stay inside the window (file strip, onboarding)
  await page.mouse.click(box.x - 40, Math.min(box.y + box.height + 30, 900 - 3))
  expect(await inEditor(page)).toBe(true)
  await page.keyboard.type('END')
  await placeCaret(page, 'Beta line', 'end')
  await page.mouse.click(box.x - 40, box.y - 10)
  expect(await inEditor(page)).toBe(true)
  await page.keyboard.type('TOP')
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('# TOPA title\n\nAlpha line of text.\n\nBeta line of text.\n\nGamma line of text.END\n')
})

test('#26: a click in the text itself is still ProseMirror\'s own', async ({ page, server, tmpRoot }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: DOC })
  const beta = await lineBox(page, 'Beta line')
  await page.mouse.click(beta.x + 6, beta.midY)
  await page.keyboard.type('X')
  // the caret is wherever ProseMirror put it, on that line
  const lines = (await savedText(ed, tmpRoot, 'k.md')).split('\n')
  expect(lines[4]!.replace('X', '')).toBe('Beta line of text.')
  expect(lines.filter((l) => l.includes('X'))).toHaveLength(1)
})
