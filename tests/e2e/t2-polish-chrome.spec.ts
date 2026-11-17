// tests/e2e/t2-polish-chrome.spec.ts (T2 polish, Pass 4 items #17, #38, #39, #40). Chrome measured on the real page:
// the mode pill never reflows the top bar, Escape closes Review settings from its gear, the frontmatter disclosure is a
// control that reads as one and an open panel gets no floating Comment bubble, and outlined buttons hold 3:1 in both
// themes. (The reply label and the history and copy wording are unit-tested.)
import { browserChoice } from '../helpers/browser'
import { openDoc, placeCaret } from './fixtures/p2'
import { expect, test } from './fixtures'
import { sel } from './fixtures/p3'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const FM = '---\nstatus: draft only\ntitle: Frontmatter check\nowner: TJ\n---\n\n# Body heading\n\nA paragraph of text.\n'
const DOC = '# Chrome check\n\nA paragraph of text for the top bar.\n'

test.describe('t2-polish: chrome', () => {
  test('#17: Editing to Suggesting at 1280x800 keeps the top bar one row and the document in place', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'bar.md', content: DOC })
    const bar = page.locator(sel('topbar'))
    const pill = page.locator(sel('modePill'))
    const heading = page.locator('#mdr-editor-host h1').first()
    const barBefore = await bar.boundingBox()
    const pillBefore = await pill.boundingBox()
    const headingBefore = await heading.boundingBox()
    // one row of controls: the bar less its file strip (onboarding, the bar's last row) is a single 48 px row
    const strip = (await page.locator(sel('fileStrip')).boundingBox())!
    expect(barBefore!.height - strip.height).toBeLessThanOrEqual(48)
    await pill.click()
    await expect(pill).toHaveAttribute('data-mode', 'suggesting')
    // the pill keeps its width (it reserves the wider label), so nothing beside it moves
    expect((await pill.boundingBox())!.width).toBe(pillBefore!.width)
    expect((await bar.boundingBox())!.height).toBe(barBefore!.height)
    expect((await heading.boundingBox())!.y).toBe(headingBefore!.y)
    expect(await ed.debug.liveMarkdown()).toBe(DOC)
  })

  test('#38: Escape closes Review settings while focus is on its gear, and focus stays on the gear', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'esc.md', content: DOC })
    const gear = page.locator(sel('railSettings'))
    const popover = page.locator('.mdr-rail-settings')
    await gear.click()
    await expect(popover).toBeVisible()
    await gear.focus()
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
    await expect(gear).toBeFocused()
  })

  test('#39: the disclosure is a bordered control beside the field count, and an open panel gets no floating Comment bubble', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'fm.md', content: FM })
    const caret = page.locator('.mdr-frontmatter__caret')
    const box = await caret.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(20)
    expect(box!.height).toBeGreaterThanOrEqual(20)
    await page.locator('.mdr-frontmatter__line').click()
    await expect(ed.testid('frontmatterPanel')).toHaveAttribute('data-expanded', 'true')
    await expect(page.locator(sel('floatingComment'))).toBeHidden()
    // the bubble still works on ordinary text: a selection in the paragraph raises it
    await placeCaret(page, 'A paragraph', 'select')
    await expect(page.locator(sel('floatingComment'))).toBeVisible()
  })

  test('#40: an outlined button border is at least 3:1 against the page, in light and dark', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: 'btn.md', content: DOC })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      const probes = await page.evaluate(() => {
        const bg = getComputedStyle(document.body).backgroundColor
        return Array.from(document.querySelectorAll<HTMLElement>('.mdr-button'))
          .filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).borderTopWidth !== '0px')
          .map((e) => ({ border: getComputedStyle(e).borderTopColor, surface: getComputedStyle(e).backgroundColor, bg }))
      })
      expect(probes.length).toBeGreaterThan(0)
      for (const p of probes) {
        const ratio = borderRatio(p.border, p.surface, p.bg)
        expect(ratio, `${scheme}: border ${p.border} on ${p.surface} against ${p.bg}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

/** Channels 0..255 and alpha from a computed colour: rgb()/rgba() or Chromium's color(srgb r g b / a). */
function channels(c: string): [number, number, number, number] {
  const srgb = c.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/)
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])]
  const rgb = c.match(/^rgba?\(([^)]+)\)$/)
  if (!rgb) throw new Error(`unparsed colour ${c}`)
  const parts = rgb[1]!.split(/[ ,/]+/).filter(Boolean).map(Number)
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1]
}

/** WCAG relative luminance of an opaque sRGB colour (channels 0..255). */
const luminance = (rgb: readonly [number, number, number]): number => {
  const [lr, lg, lb] = rgb.map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

/** The border is painted over the button's own background, so alpha blends onto that surface first; then WCAG against the page. */
function borderRatio(border: string, surface: string, page: string): number {
  const [br, bg, bb, ba] = channels(border)
  const [sr, sg, sb] = channels(surface)
  const over: [number, number, number] = [br * ba + sr * (1 - ba), bg * ba + sg * (1 - ba), bb * ba + sb * (1 - ba)]
  const [pr, pg, pb] = channels(page)
  const [l1, l2] = [luminance(over), luminance([pr, pg, pb])].sort((a, b) => b - a) as [number, number]
  return (l1 + 0.05) / (l2 + 0.05)
}
