// tests/e2e/qa1-narrow.spec.ts (QA round 1 fixes; QA_FINDINGS blockers 1-3 and majors 4, 19).
//
// The Claude browser pane is 700-900 px wide. The rail has to survive there (the breakpoint is 640 px, the doc
// column and the rail shrink first), and below the breakpoint the new-comment composer in the bottom sheet must be
// visible and focused, so typing never lands in (and overwrites) the selected text.
import { CONSTANTS, TESTID } from '../../shared/constants'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { selectText } from './fixtures/p3'

test.use({ serverKind: 'real', docFile: 'basic.md' })

const QUOTE = 'member rate of 12%'

async function layout(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null
    const doc = document.querySelector<HTMLElement>('.mdr-doc-col')!
    // 52ch in the doc column's own font
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;width:52ch;height:1px'
    doc.append(probe)
    const ch52 = probe.getBoundingClientRect().width
    probe.remove()
    const sc = document.getElementById('mdr-scroll')!
    const rail = rect('.mdr-rail')
    const docRect = rect('.mdr-doc-col')!
    return {
      narrow: document.getElementById('mdr-app')?.dataset.narrow,
      railVisible: !!rail && rail.width > 0 && getComputedStyle(document.querySelector('.mdr-rail')!).display !== 'none',
      railWidth: rail?.width ?? 0,
      railRight: rail?.right ?? 0,
      docWidth: docRect.width,
      ch52,
      overflowX: sc.scrollWidth - sc.clientWidth,
      innerWidth: window.innerWidth,
    }
  })
}

const sheet = (page: import('@playwright/test').Page) => page.locator(`[data-testid="${TESTID.sheet}"]`)

test.describe('qa1: the breakpoint', () => {
  test('is 640 px', () => {
    expect(CONSTANTS.NARROW_BREAKPOINT_PX).toBe(640)
  })

  test('639 px is narrow (sheet), 640 px is not (rail)', async ({ page, server }) => {
    await page.setViewportSize({ width: 639, height: 800 })
    await openEditor(page, { port: server.port, file: 'basic.md' })
    await expect(sheet(page)).toBeVisible()
    await page.setViewportSize({ width: 640, height: 800 })
    await expect(sheet(page)).toHaveCount(0)
  })

  for (const w of [641, 700, 800, 899]) {
    test(`${w} px keeps the rail: min rail 240, no horizontal overflow, column still readable`, async ({ page, server }) => {
      await page.setViewportSize({ width: w, height: 800 })
      await openEditor(page, { port: server.port, file: 'basic.md' })
      const l = await layout(page)
      expect(l.narrow).toBe('false')
      expect(l.railVisible).toBe(true)
      expect(l.railWidth).toBeGreaterThanOrEqual(239.5)
      expect(l.railRight).toBeLessThanOrEqual(l.innerWidth)
      expect(l.overflowX).toBeLessThanOrEqual(0)
      // the doc column keeps about 48ch at 800 (52ch needs 840 px next to a 240 px rail); lower down it only gives up
      // what the rail needs and stays at 28ch or better
      if (w >= 800) expect(l.docWidth).toBeGreaterThanOrEqual(l.ch52 * 0.92)
      else expect(l.docWidth).toBeGreaterThanOrEqual(l.ch52 * 0.54)
    })
  }
})

test.describe('qa1: commenting at pane widths', () => {
  for (const w of [800, 700]) {
    test(`${w} px (rail mode): the Comment button opens a visible, focused composer and typing leaves the text alone`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: 800 })
      const ed = await openEditor(page, { port: server.port, file: 'basic.md' })
      const before = tmpRoot.read('basic.md')
      await selectText(page, { from: QUOTE })
      await page.locator(`[data-testid="${TESTID.commentButton}"]`).click()
      const card = page.locator(`[data-testid="${TESTID.card}"][data-draft="true"]`)
      await expect(card).toBeVisible()
      const area = card.locator(`[data-testid="${TESTID.cardReply}"]`)
      await expect(area).toBeFocused()
      await page.keyboard.type('Is this still current?')
      await expect(area).toHaveValue('Is this still current?')
      await ed.settled()
      await page.waitForTimeout(900)
      expect(tmpRoot.read('basic.md')).toBe(before)
    })
  }

  for (const w of [620, 400]) {
    test(`${w} px (sheet mode): the Comment button opens the sheet on a visible, focused composer`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: 800 })
      const ed = await openEditor(page, { port: server.port, file: 'basic.md' })
      const before = tmpRoot.read('basic.md')
      await selectText(page, { from: QUOTE })
      await page.locator(`[data-testid="${TESTID.commentButton}"]`).click()
      await expect(sheet(page)).toHaveAttribute('data-open', 'true')
      const card = sheet(page).locator(`[data-testid="${TESTID.card}"][data-draft="true"]`)
      await expect(card).toBeVisible()
      const area = card.locator(`[data-testid="${TESTID.cardReply}"]`)
      await expect(area).toBeVisible()
      await expect(area).toBeFocused()
      await page.keyboard.type('Is this still current?')
      await expect(area).toHaveValue('Is this still current?')
      await ed.settled()
      await page.waitForTimeout(900)
      expect(tmpRoot.read('basic.md')).toBe(before)
    })

    test(`${w} px (sheet mode): Cmd+Opt+M does the same`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: 800 })
      await openEditor(page, { port: server.port, file: 'basic.md' })
      const before = tmpRoot.read('basic.md')
      await selectText(page, { from: QUOTE })
      await page.keyboard.press('Meta+Alt+m')
      const area = sheet(page).locator(`[data-testid="${TESTID.card}"][data-draft="true"] [data-testid="${TESTID.cardReply}"]`)
      await expect(area).toBeVisible()
      await expect(area).toBeFocused()
      await page.keyboard.type('hello')
      await expect(area).toHaveValue('hello')
      await page.waitForTimeout(900)
      expect(tmpRoot.read('basic.md')).toBe(before)
    })
  }
})

test.describe('qa1: the composer is brought into view (confirmed 6)', () => {
  test('a selection near the bottom of the pane: Comment scrolls the new-comment card fully into view and focuses it', async ({ page, server, tmpRoot }) => {
    const { railDoc } = await import('./fixtures/p3')
    tmpRoot.write('rail.md', railDoc(36))
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: 'rail.md' })
    // marker20x sits at the very bottom of the visible band
    await page.evaluate(() => {
      const sc = document.getElementById('mdr-scroll')!
      const walker = document.createTreeWalker(document.getElementById('mdr-editor-host')!, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const i = n.data.indexOf('marker20x')
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + 9)
        sc.scrollTop += r.getBoundingClientRect().top - (sc.getBoundingClientRect().bottom - 60)
        return
      }
    })
    await page.waitForTimeout(200)
    await selectText(page, { from: 'marker20x', reveal: false })
    await page.locator(`[data-testid="${TESTID.floatingComment}"]`).click()
    const card = page.locator(`[data-testid="${TESTID.card}"][data-draft="true"]`)
    await expect(card).toBeVisible()
    const area = card.locator(`[data-testid="${TESTID.cardReply}"]`)
    await expect(area).toBeFocused()
    await ed.settled()
    await page.waitForTimeout(300)
    const box = await card.boundingBox()
    const sc = await page.locator('#mdr-scroll').boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(sc!.y - 1)
    expect(box!.y + box!.height).toBeLessThanOrEqual(sc!.y + sc!.height + 1)
  })
})
