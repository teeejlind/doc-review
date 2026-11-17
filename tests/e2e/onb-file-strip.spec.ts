// tests/e2e/onb-file-strip.spec.ts (onboarding): the "where's my file" strip under the top bar.
//
// A reader who doesn't know where the document lives on disk sees its folder and name in a quiet row at the bottom of
// the top bar, can copy the absolute path, and can ask for it in Finder (Explorer, the file manager). The real server
// runs with MDR_TEST_HOOKS=1, so Reveal records the request instead of opening Finder (GET /__test/reveals). The strip
// sits inside the header (--shell-topbar-height covers it), never overflows a 375 px phone, and reads in dark mode.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { browserChoice } from '../helpers/browser'
import { browserHeaders } from '../helpers/startServer'
import { installClipboard, sel } from './fixtures/p3'
import { openDoc } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const FILE = 'notes/plan.md'
const DOC = '# Plan\n\nA paragraph about where this file lives.\n'
const SHOTS = process.env.MDR_STRIP_SHOTS

async function open(page: Page, server: { port: number }, tmpRoot: Parameters<typeof openDoc>[1]['tmpRoot']) {
  mkdirSync(join(tmpRoot.root, 'notes'), { recursive: true })
  return openDoc(page, { port: server.port, tmpRoot, file: FILE, content: DOC })
}

test('the strip shows the file name and its folder, with the full path as the tooltip', async ({ page, server, tmpRoot }) => {
  await open(page, server, tmpRoot)
  const strip = page.locator(sel('fileStrip'))
  await expect(strip).toBeVisible()
  await expect(strip.locator('[data-role="name"]')).toHaveText('plan.md')
  const abs = join(tmpRoot.root, 'notes', 'plan.md')
  const dirShown = await strip.locator('[data-role="dir"]').textContent()
  // the file's own folder, absolute, with the home folder read as ~ (macOS /Users/<you>, Linux /home/<you>)
  const dir = join(tmpRoot.root, 'notes')
  expect(dirShown).toBe(process.platform === 'win32' ? dir : dir.replace(/^\/(?:Users\/(?!Shared(?:\/|$))[^/]+|home\/[^/]+)(?=\/|$)/, '~'))
  await expect(strip.locator('.mdr-file-strip-path')).toHaveAttribute('title', abs)
  await expect(page.locator(sel('fileStripReveal'))).toHaveText(process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in folder')
  // inside the top bar, so the measured bar height (fixed panels start under it) includes the strip
  const geo = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('[data-testid="mdr-topbar"]')!
    const s = document.querySelector<HTMLElement>('[data-testid="mdr-file-strip"]')!
    const b = bar.getBoundingClientRect()
    const r = s.getBoundingClientRect()
    return { inside: bar.contains(s), barBottom: b.bottom, stripBottom: r.bottom, stripHeight: r.height, barLeft: b.left, barRight: b.right, left: r.left, right: r.right, token: getComputedStyle(document.querySelector('#mdr-app')!).getPropertyValue('--shell-topbar-height') }
  })
  expect(geo.inside).toBe(true)
  expect(geo.stripHeight).toBeGreaterThanOrEqual(26)
  expect(geo.stripHeight).toBeLessThanOrEqual(32)
  expect(Math.abs(geo.barBottom - geo.stripBottom)).toBeLessThanOrEqual(1.5)
  expect(Math.abs(geo.left - geo.barLeft)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(geo.right - geo.barRight)).toBeLessThanOrEqual(0.5)
  expect(parseInt(geo.token, 10)).toBe(Math.round(geo.barBottom))
})

test('Copy path writes the absolute path with native separators and says Copied', async ({ page, server, tmpRoot }) => {
  await installClipboard(page)
  await open(page, server, tmpRoot)
  const copy = page.locator(sel('fileStripCopy'))
  await copy.click()
  await expect(copy).toHaveAttribute('data-state', 'copied')
  await expect(copy).toContainText('Copied')
  const writes = await page.evaluate(() => (window as unknown as { __clipWrites: string[] }).__clipWrites)
  expect(writes).toEqual([join(tmpRoot.root, 'notes', 'plan.md')])
  await expect(copy).toHaveAttribute('data-state', 'idle', { timeout: 4_000 })

  // a refused clipboard: the button says so and a toast carries the path to copy by hand
  await page.evaluate(() => { (window as unknown as { __clipRefuse: boolean }).__clipRefuse = true })
  await copy.click()
  await expect(copy).toHaveAttribute('data-state', 'failed')
  await expect(page.locator(sel('toast')).filter({ hasText: join(tmpRoot.root, 'notes', 'plan.md') })).toBeVisible()
})

test('Reveal posts /api/reveal and the server records it (test hooks: no Finder window)', async ({ page, server, tmpRoot }) => {
  await open(page, server, tmpRoot)
  const reveals = async (): Promise<Array<{ file: string; abs: string }>> => {
    const r = await fetch(`${server.origin}/__test/reveals`, { headers: browserHeaders({ token: server.token, port: server.port }) })
    expect(r.status).toBe(200)
    return ((await r.json()) as { reveals: Array<{ file: string; abs: string }> }).reveals
  }
  expect(await reveals()).toEqual([])
  const posted = page.waitForResponse((r) => r.url().includes('/api/reveal') && r.request().method() === 'POST')
  await page.locator(sel('fileStripReveal')).click()
  const res = await posted
  expect(res.status()).toBe(200)
  expect(res.request().postDataJSON()).toEqual({ file: FILE })
  const list = await reveals()
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ file: FILE, abs: join(tmpRoot.root, 'notes', 'plan.md') })
  await expect(page.locator(sel('toast'))).toHaveCount(0)
})

test('375 px: no horizontal overflow, the folder text goes, the buttons keep icons and labels for screen readers', async ({ page, server, tmpRoot }) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await open(page, server, tmpRoot)
  const strip = page.locator(sel('fileStrip'))
  await expect(strip).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  const m = await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[data-testid="mdr-file-strip"]')!
    const r = s.getBoundingClientRect()
    const out = [...s.querySelectorAll<HTMLElement>('*')].filter((e) => e.getClientRects().length > 0).map((e) => e.getBoundingClientRect())
      .filter((b) => b.left < -0.5 || b.right > window.innerWidth + 0.5).length
    return { left: r.left, right: r.right, overflow: s.scrollWidth - s.clientWidth, out }
  })
  expect(m.left).toBeGreaterThanOrEqual(0)
  expect(m.right).toBeLessThanOrEqual(375)
  expect(m.overflow).toBeLessThanOrEqual(0)
  expect(m.out).toBe(0)
  await expect(strip.locator('[data-role="dir"]')).toBeHidden()
  await expect(strip.locator('[data-role="name"]')).toBeVisible()
  await expect(page.locator(sel('fileStripCopy'))).toHaveAccessibleName('Copy path')
  await expect(page.locator(sel('fileStripReveal'))).toHaveAccessibleName(/Finder|Explorer|folder/)
  await expect(page.locator(sel('fileStripCopy')).locator('.mdr-file-strip-label')).toBeHidden()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}: the strip's text reads against the bar`, async ({ page, server, tmpRoot }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await open(page, server, tmpRoot)
    const c = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="mdr-topbar"]')!
      const s = document.querySelector<HTMLElement>('[data-testid="mdr-file-strip"]')!
      const name = s.querySelector<HTMLElement>('[data-role="name"]')!
      const btn = document.querySelector<HTMLElement>('[data-testid="mdr-file-strip-copy"]')!
      return { bg: getComputedStyle(bar).backgroundColor, strip: getComputedStyle(s).color, name: getComputedStyle(name).color, btn: getComputedStyle(btn).color, border: getComputedStyle(s).borderTopColor }
    })
    for (const k of ['strip', 'name', 'btn', 'border'] as const) expect(c[k], k).not.toBe(c.bg)
    // dark mode is dark: the bar's background is darker than its text
    const lum = (rgb: string): number => {
      const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number)
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
    }
    if (scheme === 'dark') expect(lum(c.bg)).toBeLessThan(lum(c.name))
    else expect(lum(c.bg)).toBeGreaterThan(lum(c.name))
    if (SHOTS) {
      for (const w of [1280, 375]) {
        await page.setViewportSize({ width: w, height: 800 })
        await page.waitForTimeout(150)
        await page.screenshot({ path: join(SHOTS, `strip-${scheme}-${w}.png`), clip: { x: 0, y: 0, width: w, height: w > 600 ? 260 : 360 } })
      }
    }
  })
}
