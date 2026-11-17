// tests/e2e/onb-topbar-pill.spec.ts (onboarding, merged-main bug): at 1440×1000 on a 2x screen the top bar was so full
// (file name, Claude badge, Comment, nav arrows, Saved, history, Export, Send) that the toolbar scrolled inside its own
// box and the mode pill, its last item, read "Suggestinc". The name moved to the file strip and the toolbar keeps its
// whole width at desktop sizes. With the row at its most crowded (a Claude comment, then Send so the badge shows its
// longest text) the pill is whole: not clipped, inside the window, and nothing covers it.
import type { Page } from '@playwright/test'
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { installClipboard, sel } from './fixtures/p3'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [], deviceScaleFactor: 2 })
test.skip(!BROWSER.available, BROWSER.reason)

const FILE = 'a-fairly-long-quarterly-planning-memo-name.md'
const DOC = '# Pill\n\nA paragraph to type in, with a member rate of 12% in it.\n\nAnother paragraph after it.\n'

async function pillGeometry(page: Page) {
  return page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>('[data-testid="mdr-mode-pill"]')!
    const r = pill.getBoundingClientRect()
    const inset = 3
    const points: Array<[number, number]> = [
      [r.left + inset, r.top + inset], [r.right - inset, r.top + inset], [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset], [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
    ]
    const covered = points.filter(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      return !hit || !(hit === pill || pill.contains(hit))
    }).length
    // every ancestor up to the top bar shows the pill whole (no ancestor clips it)
    let clippedBy: string | null = null
    for (let el = pill.parentElement; el && !el.matches('[data-testid="mdr-topbar"]'); el = el.parentElement) {
      const b = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (cs.overflowX !== 'visible' && (r.left < b.left - 0.5 || r.right > b.right + 0.5)) clippedBy = el.id || el.className
    }
    return {
      scrollWidth: pill.scrollWidth, clientWidth: pill.clientWidth, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      vw: window.innerWidth, vh: window.innerHeight, covered, clippedBy, text: pill.textContent,
    }
  })
}

for (const [w, h] of [[1280, 800], [1440, 1000]] as const) {
  test(`${w}×${h} @2x: with the bar at its most crowded the mode pill is whole and uncovered`, async ({ page, server, tmpRoot, cli }) => {
    tmpRoot.write(FILE, DOC)
    const r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'member rate of 12%', body: 'Is 12% still current?' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    await installClipboard(page)
    await page.setViewportSize({ width: w, height: h })
    await openEditor(page, { port: server.port, file: FILE })
    await expect(page.locator(sel('claudeBadge'))).toBeVisible()
    // Send: the badge's longest text
    await page.locator('#mdr-editor-host .ProseMirror').click()
    await page.keyboard.type('x')
    await page.locator(sel('send')).click()
    await expect(page.locator(sel('claudeBadge'))).toContainText('Waiting for you to paste it into Claude')
    for (const mode of ['suggesting', 'editing'] as const) {
      const pill = page.locator(sel('modePill'))
      if ((await pill.getAttribute('data-mode')) !== mode) await pill.click()
      await expect(pill).toHaveAttribute('data-mode', mode)
      const g = await pillGeometry(page)
      expect(g.scrollWidth, `${mode}: pill text cut (${g.text})`).toBeLessThanOrEqual(g.clientWidth)
      expect(g.left).toBeGreaterThanOrEqual(0)
      expect(g.top).toBeGreaterThanOrEqual(0)
      expect(g.right).toBeLessThanOrEqual(g.vw)
      expect(g.bottom).toBeLessThanOrEqual(g.vh)
      expect(g.clippedBy, `${mode}: pill clipped by an ancestor`).toBeNull()
      expect(g.covered, `${mode}: something covers the pill`).toBe(0)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w)
    if (process.env.MDR_STRIP_SHOTS) await page.screenshot({ path: `${process.env.MDR_STRIP_SHOTS}/strip-pill-${w}.png`, clip: { x: 0, y: 0, width: w, height: 120 } })
  })
}
