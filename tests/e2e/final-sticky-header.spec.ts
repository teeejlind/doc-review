// tests/e2e/final-sticky-header.spec.ts (final pass 2026-11-16): the 0.1.4 sticky table header (web/src/editor/
// stickyHeader.ts) had no e2e spec. A long table's header row stays pinned to the top of the scroll box while the
// reader scrolls through the table, rides up with the last row and lets go past it; the same for a table wider than
// the column (translate path) while it is scrolled sideways; a comment on a header cell keeps its card level with the
// header's real place; and the saved file is untouched by any of it.
import { browserChoice } from '../helpers/browser'
import { claude, openDoc } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })
test.skip(!BROWSER.available, BROWSER.reason)

const rows = (n: number, cols: number): string =>
  Array.from({ length: n }, (_, i) => `| ${Array.from({ length: cols }, (_, c) => `r${i + 1}c${c + 1}`).join(' | ')} |`).join('\n')
const table = (cols: number, n: number, word = 'Head'): string =>
  `| ${Array.from({ length: cols }, (_, c) => `${word}${c + 1}`).join(' | ')} |\n|${' --- |'.repeat(cols)}\n${rows(n, cols)}`
const filler = Array.from({ length: 8 }, (_, i) => `Filler paragraph ${i + 1} before the table, long enough to take some room on the page.`).join('\n\n')
const FIT = `# Fits\n\n${filler}\n\n${table(3, 60)}\n\n${filler.replace(/before/g, 'after')}\n`
const WIDE = `# Wide\n\n${filler}\n\n${table(14, 60, 'LongHeaderName')}\n\n${filler.replace(/before/g, 'after')}\n`

type Geo = { scrollTop: number; headTop: number; boxTop: number; lastRowBottom: number; tableTop: number }
async function geo(page: import('@playwright/test').Page): Promise<Geo> {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.mdr-scroll')!
    const t = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror > table')!
    const th = t.querySelector<HTMLElement>('th')!
    const trs = t.querySelectorAll('tr')
    return {
      scrollTop: box.scrollTop, boxTop: box.getBoundingClientRect().top, headTop: th.getBoundingClientRect().top,
      tableTop: t.getBoundingClientRect().top, lastRowBottom: trs[trs.length - 1]!.getBoundingClientRect().bottom,
    }
  })
}
async function scrollTo(page: import('@playwright/test').Page, y: (g: Geo) => number): Promise<Geo> {
  const g0 = await geo(page)
  await page.evaluate((top) => { document.querySelector<HTMLElement>('.mdr-scroll')!.scrollTop = top }, y(g0))
  // two frames: the scroll event, then the plugin's rAF
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return geo(page)
}

for (const [name, doc] of [['a table that fits the column', FIT], ['a table wider than the column', WIDE]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`final sticky header: ${name} (${scheme})`, async ({ page, server, tmpRoot }) => {
      await page.emulateMedia({ colorScheme: scheme })
      const ed = await openDoc(page, { port: server.port, tmpRoot, file: 's.md', content: doc })
      if (name.startsWith('a table wider')) {
        // scrolled sideways: the header still pins
        await page.evaluate(() => { document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror > table')!.scrollLeft = 300 })
      }
      const start = await geo(page)
      // the header in its own place before the table reaches the top
      expect(Math.abs(start.headTop - start.tableTop)).toBeLessThan(3)
      // mid-table: pinned at the top edge of the scroll box
      const mid = await scrollTo(page, (g) => g.scrollTop + (g.tableTop - g.boxTop) + 600)
      expect(Math.abs(mid.headTop - mid.boxTop)).toBeLessThan(3)
      const mid2 = await scrollTo(page, (g) => g.scrollTop + 400)
      expect(Math.abs(mid2.headTop - mid2.boxTop)).toBeLessThan(3)
      // the header is painted above the rows it covers (opaque background, on top)
      const cover = await page.evaluate((y) => {
        const t = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror > table')!
        const left = t.getBoundingClientRect().left
        // the first header cell in view (a wide table is scrolled sideways)
        const th = [...t.querySelectorAll<HTMLElement>('th')].find((x) => x.getBoundingClientRect().left >= left - 1)!
        const r = th.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + 4, y + 4)
        return { onTop: !!hit && (hit === th || th.contains(hit)), bg: getComputedStyle(th).backgroundColor }
      }, mid2.boxTop)
      expect(cover.onTop).toBe(true)
      expect(cover.bg).not.toBe('rgba(0, 0, 0, 0)')
      // past the table: released, it rides away with the table (never below the last row)
      const past = await scrollTo(page, (g) => g.scrollTop + (g.lastRowBottom - g.boxTop) + 200)
      expect(past.headTop).toBeLessThan(past.boxTop)
      expect(past.headTop).toBeLessThanOrEqual(past.lastRowBottom)
      // back to the top: in its own place again
      const back = await scrollTo(page, () => 0)
      expect(Math.abs(back.headTop - back.tableTop)).toBeLessThan(3)
      // nothing of it reaches the file
      expect(await ed.debug.planSave()).toEqual([])
      expect(tmpRoot.read('s.md')).toBe(doc)
    })
  }
}

test('final sticky header: a comment on a header cell keeps its card level with the header while it is pinned', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'c.md', content: FIT })
  // a second comment lower down so the rail lays out while the header is pinned
  await claude(server, 'c.md', [
    { op: 'comment', quote: 'Head2', body: 'Is this the right column name?' },
    { op: 'comment', quote: 'r40c2', body: 'Check this value.' },
  ])
  await expect(page.locator('[data-testid="mdr-card"]')).toHaveCount(2)
  await scrollTo(page, (g) => g.scrollTop + (g.tableTop - g.boxTop) + 700)
  await page.locator('[data-testid="mdr-card"]').filter({ hasText: 'Check this value.' }).click()
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)))
  await scrollTo(page, () => 0)
  await page.locator('[data-testid="mdr-card"]').filter({ hasText: 'Is this the right column name?' }).click()
  await page.evaluate(() => new Promise((r) => setTimeout(r, 600)))
  const { card, head } = await page.evaluate(() => {
    const th = [...document.querySelectorAll<HTMLElement>('#mdr-editor-host th')].find((x) => x.textContent === 'Head2')!
    const c = [...document.querySelectorAll<HTMLElement>('[data-testid="mdr-card"]')].find((x) => x.textContent!.includes('right column name'))!
    return { card: c.getBoundingClientRect().top, head: th.getBoundingClientRect().top }
  })
  expect(Math.abs(card - head)).toBeLessThan(40)
  expect(await ed.debug.planSave()).toEqual([])
})
