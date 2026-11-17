// tests/e2e/qa4-layout-tables.spec.ts (QA round 4, Pass 4 item #1 "wide tables run past the document column").
//
// A table wider than the document column must stay inside the column and scroll horizontally inside its own box, so the
// comment rail never sits over a cell and every column is reachable at 700 px. Each test is the failing repro first.
import { openDoc } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [] })

const FILE = 'qa4-wide.md'
const LONG = 'supercalifragilisticexpialidocious-segment-number-one'
const TABLE = [
  '# Link map',
  '',
  'Intro paragraph before the table.',
  '',
  `| Source page | Target page | Anchor text | Owner team | Last checked ${LONG} |`,
  '| - | - | - | - | - |',
  `| live Home | /garden/${LONG} | plots page | Volunteers | 2026-10-01 |`,
  `| live Tools | /tools/${LONG} | tool library | Growth | 2026-10-02 |`,
  '',
  'Text after the table.',
  '',
].join('\n')

/** The table's own box, the column it lives in, and the scroll box that holds it (the table itself or an ancestor). */
async function geometry(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const table = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror table')!
    const col = document.querySelector<HTMLElement>('.mdr-doc-col')!.getBoundingClientRect()
    const rail = document.querySelector<HTMLElement>('.mdr-rail')!.getBoundingClientRect()
    let scroller: HTMLElement = table
    for (let p: HTMLElement | null = table; p; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX
      if (ov === 'auto' || ov === 'scroll') {
        scroller = p
        break
      }
    }
    const tr = table.getBoundingClientRect()
    const sr = scroller.getBoundingClientRect()
    const lastCell = Array.from(table.querySelectorAll<HTMLElement>('tr:first-child > *')).pop()!.getBoundingClientRect()
    return {
      colLeft: col.left,
      colRight: col.right,
      railLeft: rail.left,
      tableRight: tr.right,
      scrollerRight: sr.right,
      scrollerClientWidth: scroller.clientWidth,
      scrollerScrollWidth: scroller.scrollWidth,
      scrollerIsTable: scroller === table,
      // what the reader can see of the table: its box clipped to its scroll box
      visibleRight: Math.min(tr.right, sr.right),
      lastCellRight: lastCell.right,
      scrollerLeft: sr.left,
    }
  })
}

for (const [w, h] of [
  [1440, 900],
  [700, 700],
] as const) {
  test(`${w}x${h}: a wide table stays inside the document column and scrolls inside its own box`, async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: w, height: h })
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: TABLE })
    await expect(page.locator('#mdr-editor-host .ProseMirror table')).toBeVisible()
    const g = await geometry(page)
    // the table never runs into the rail zone or past the column
    expect(g.visibleRight, 'visible table edge vs column right').toBeLessThanOrEqual(g.colRight + 1)
    expect(g.visibleRight, 'visible table edge vs rail left').toBeLessThanOrEqual(g.railLeft)
    // it is wider than the column, so it must scroll in its own box, and the last column is reachable by scrolling
    expect(g.scrollerScrollWidth, 'scroll box holds the overflow').toBeGreaterThan(g.scrollerClientWidth)
    await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror table')!
      let scroller: HTMLElement = table
      for (let p: HTMLElement | null = table; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX
        if (ov === 'auto' || ov === 'scroll') {
          scroller = p
          break
        }
      }
      scroller.scrollLeft = scroller.scrollWidth
    })
    const after = await geometry(page)
    expect(after.lastCellRight, 'last column reachable inside the column').toBeLessThanOrEqual(after.colRight + 1)
    expect(after.lastCellRight, 'last column reachable inside the scroll box').toBeLessThanOrEqual(after.scrollerRight + 1)
  })
}
