// tests/e2e/qa3-theme-polish.spec.ts (QA round 3, fixer "theme-polish", round 1).
//
// Chrome-level fixes that only show up in a real browser (computed styles, geometry, tab order): the save chip while
// the rest of the bar is quiet, the top bar at pane widths with the long badge copy, the version-history panel's top
// edge, the switch contrast, the toolbar's tab stops. Each test is the failing repro from QA_FINDINGS first.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { CONSTANTS } from '../../shared/constants'
import type { Presence } from '../../shared/types'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { clipWrites, installClipboard, openRailSettings, sel } from './fixtures/p3'

const FILE = 'qa3.md'
test.use({ serverKind: 'real', fixtureFiles: [], docFile: FILE })

const DOC = '# Polish\n\nA paragraph to type in, with a member rate of 12% in it.\n\nAnother paragraph after it.\n'

/** The element's opacity times every ancestor's: what the eye sees. */
const effectiveOpacity = (page: Page, selector: string): Promise<number> =>
  page.evaluate((s) => {
    let o = 1
    for (let el = document.querySelector<HTMLElement>(s); el; el = el.parentElement) o *= Number(getComputedStyle(el).opacity)
    return o
  }, selector)

test.describe('qa3 theme-polish: quiet chrome keeps the save state visible (R1.5)', () => {
  test('Offline stays at full opacity through continuous typing while Send fades', async ({ page, server, tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.mouse.move(640, 400)
    await openEditor(page, { port: server.port, file: FILE })
    await page.locator(sel('editor')).click()
    await server.stop()
    const end = Date.now() + CONSTANTS.QUIET_CHROME_AFTER_MS + 3000
    while (Date.now() < end) await page.keyboard.type('more ', { delay: 40 })
    await expect(page.locator(sel('saveChip'))).toHaveAttribute('data-state', 'offline')
    await expect(page.locator(sel('topbar'))).toHaveAttribute('data-quiet', 'true')
    // the rest of the bar has faded ...
    await expect.poll(() => effectiveOpacity(page, sel('send'))).toBeLessThan(0.5)
    // ... the warning has not
    expect(await effectiveOpacity(page, sel('saveChip'))).toBe(1)
  })
})

/** WCAG contrast of a computed colour (rgb() or color(srgb …), alpha allowed) drawn over an opaque page colour. */
const contrast = (fg: string, page: string): number => {
  const parse = (c: string): { rgb: [number, number, number]; a: number } => {
    const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c)
    if (srgb) return { rgb: [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])], a: srgb[4] === undefined ? 1 : Number(srgb[4]) }
    const m = /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)/.exec(c)
    if (!m) throw new Error(`unparsed colour ${c}`)
    return { rgb: [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255], a: m[4] === undefined ? 1 : Number(m[4]) }
  }
  const back = parse(page).rgb
  const top = parse(fg)
  const over = top.rgb.map((v, i) => v * top.a + back[i]! * (1 - top.a)) as [number, number, number]
  const lum = (c: readonly number[]): number => {
    const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [hi, lo] = [lum(over), lum(back)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

test.describe('qa3 theme-polish: the OFF switch is identifiable (WCAG 1.4.11)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the OFF track of Show resolved is at least 3:1 against the page (${scheme})`, async ({ page, server, tmpRoot }) => {
      tmpRoot.write(FILE, DOC)
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1280, height: 800 })
      await openEditor(page, { port: server.port, file: FILE })
      const sw = page.locator(sel('showResolved'))
      await expect(sw).toHaveAttribute('aria-checked', 'false')
      const track = await sw.locator('.mdr-switch-track').evaluate((el) => getComputedStyle(el).backgroundColor)
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      expect(contrast(track, bg)).toBeGreaterThanOrEqual(3)
    })
  }
})

/** What the top bar looks like at one width: its height and whether the actions row (Send last) sits inside the window. */
async function topbar(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 })
  await page.waitForTimeout(120)
  return page.evaluate(() => {
    const box = (s: string) => document.querySelector(s)!.getBoundingClientRect()
    const send = box('[data-testid="mdr-send"]')
    const bar = box('[data-testid="mdr-topbar"]')
    return { vw: window.innerWidth, height: Math.round(bar.height), sendLeft: Math.round(send.left), sendRight: Math.round(send.right), docTop: Math.round(box('.mdr-doc-col').top) }
  })
}

test.describe('qa3 theme-polish: a Claude badge never moves the document or pushes Send off screen', () => {
  test.use({ serverKind: 'fake' })
  const WIDTHS = [1440, 1280, 1100, 900, 800, 720, 700, 640]

  async function states(page: Page, server: { fake?: { setPresence(f: string, p: Presence | null): Promise<void> } }, port: number) {
    await installClipboard(page)
    await server.fake!.setPresence(FILE, { waiter: 'grace', graceUntil: new Date(Date.now() + 300_000).toISOString() })
    await page.setViewportSize({ width: 1280, height: 800 })
    await openEditor(page, { port, file: FILE, wait: 'editor' })
    const idle: Record<number, Awaited<ReturnType<typeof topbar>>> = {}
    for (const w of WIDTHS) idle[w] = await topbar(page, w)
    return idle
  }

  test('queued badge (the long copy): same bar height as idle at every width, Send fully on screen', async ({ page, server, tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
    const idle = await states(page, server, server.port)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.locator(sel('send')).click()
    await expect(page.locator(sel('claudeBadge'))).toContainText('Queued')
    for (const w of WIDTHS) {
      const m = await topbar(page, w)
      expect(m.height, `${w}px: bar height with the badge vs idle`).toBe(idle[w]!.height)
      expect(m.docTop, `${w}px: the document does not move`).toBe(idle[w]!.docTop)
      expect(m.sendRight, `${w}px: Send inside the window`).toBeLessThanOrEqual(m.vw)
      expect(m.sendLeft, `${w}px`).toBeGreaterThanOrEqual(0)
    }
  })

  test('waiting-to-paste badge (clipboard + Copy message): same bar height as idle, Send fully on screen', async ({ page, server, tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
    const idle = await states(page, server, server.port)
    await server.fake!.setPresence(FILE, { waiter: 'none' })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.locator(sel('send')).click()
    await expect(page.locator(sel('claudeBadge'))).toContainText('Waiting for you to paste it into Claude')
    expect((await clipWrites(page)).length).toBe(1)
    for (const w of WIDTHS) {
      const m = await topbar(page, w)
      expect(m.height, `${w}px: bar height with the badge vs idle`).toBe(idle[w]!.height)
      expect(m.sendRight, `${w}px: Send inside the window`).toBeLessThanOrEqual(m.vw)
      expect(m.sendLeft, `${w}px`).toBeGreaterThanOrEqual(0)
    }
  })

  test('a long save-chip message (Offline) next to the badge still leaves Send on screen at pane widths', async ({ page, server, tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
    await states(page, server, server.port)
    await page.locator(sel('send')).click()
    await expect(page.locator(sel('claudeBadge'))).toContainText('Queued')
    await page.evaluate(() => {
      const chip = document.querySelector('[data-testid="mdr-save-chip"]')!
      chip.querySelector('.mdr-save-chip-label')!.textContent = 'Offline: changes kept on this device'
    })
    for (const w of [900, 800, 720, 700, 640]) {
      const m = await topbar(page, w)
      expect(m.sendRight, `${w}px: Send inside the window`).toBeLessThanOrEqual(m.vw)
    }
  })
})

test.describe('qa3 theme-polish: the version history panel starts under the real top bar', () => {
  for (const w of [1280, 900, 800, 700]) {
    test(`${w} px: the panel's top is the bar's bottom, the History button stays uncovered, one banner landmark`, async ({ page, server, tmpRoot }) => {
      tmpRoot.write(FILE, DOC)
      await page.setViewportSize({ width: w, height: 800 })
      await openEditor(page, { port: server.port, file: FILE })
      await page.locator(sel('historyButton')).click()
      await expect(page.locator(sel('historyPanel'))).toBeVisible()
      const m = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="mdr-topbar"]')!.getBoundingClientRect()
        const panel = document.querySelector('[data-testid="mdr-history-panel"]')!.getBoundingClientRect()
        const btn = document.querySelector('[data-testid="mdr-history-button"]')!.getBoundingClientRect()
        const at = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2)
        return {
          barBottom: Math.round(bar.bottom),
          panelTop: Math.round(panel.top),
          buttonUncovered: !!at?.closest('[data-testid="mdr-history-button"]'),
          banners: document.querySelectorAll('header, [role="banner"]').length,
        }
      })
      expect(m.panelTop).toBe(m.barBottom)
      expect(m.buttonUncovered).toBe(true)
      expect(m.banners).toBe(1)
    })
  }
})

test.describe('qa3 theme-polish: names that match what is on screen (WCAG 2.5.3) and one tab stop for the toolbar', () => {
  test.use({ fixtureFiles: 'all' })

  for (const doc of ['basic.md', 'syn__frontmatter.md', 'syn__block-html.md', 'syn__status-header.md']) {
    for (const w of [800, 1280]) {
      test(`axe: no serious findings on ${doc} at ${w} px (label-content-name-mismatch included)`, async ({ page, server }) => {
        await page.setViewportSize({ width: w, height: 800 })
        await openEditor(page, { port: server.port, file: doc })
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
        const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
        const report = bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' ; ')}`).join('\n')
        expect(bad, report).toEqual([])
      })
    }
  }

  test('Tab from the top of the page reaches the editor in a handful of presses, not eighteen', async ({ page, server }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openEditor(page, { port: server.port, file: 'basic.md' })
    await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      document.body.focus()
    })
    let presses = 0
    for (; presses < 40; presses++) {
      await page.keyboard.press('Tab')
      if (await page.evaluate(() => !!document.activeElement?.closest('[data-testid="mdr-editor"]'))) break
    }
    // 9 since the top bar's Export menu (one more control before Send), 11 since the file strip's Reveal and Copy path
    // (onboarding); the point is "a handful, not eighteen"
    expect(presses + 1).toBeLessThanOrEqual(11)
    // and the toolbar answers to its arrow keys: Undo and Redo come first (rail-ui), then Bold, Italic
    await page.locator('[data-testid="mdr-toolbar-button"]').first().focus()
    const focused = (): Promise<string | null | undefined> => page.evaluate(() => document.activeElement?.getAttribute('data-action'))
    expect(await focused()).toBe('undo')
    await page.keyboard.press('ArrowRight')
    expect(await focused()).toBe('redo')
    await page.keyboard.press('ArrowRight')
    expect(await focused()).toBe('bold')
    await page.keyboard.press('ArrowRight')
    expect(await focused()).toBe('italic')
  })
})

test.describe('qa3 theme-polish: a quiet rail header that keeps its words on one line', () => {
  test('nothing pending: Comment and a settings button; the switches and their explanations are behind it', async ({ page, server, tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
    await page.setViewportSize({ width: 1280, height: 800 })
    await openEditor(page, { port: server.port, file: FILE })
    await expect(page.locator(sel('docComment'))).toBeVisible()
    await expect(page.locator(sel('railSettings'))).toBeVisible()
    await expect(page.locator(sel('showResolved'))).toBeHidden()
    await expect(page.locator(sel('policyToggle'))).toBeHidden()
    await expect(page.locator(sel('acceptAllClaude'))).toHaveCount(0)
    await expect(page.locator(sel('rejectAllClaude'))).toHaveCount(0)
    const quiet = await page.locator(sel('railHeader')).evaluate((el) => el.getBoundingClientRect().height)
    await openRailSettings(page)
    await expect(page.locator(sel('showResolved'))).toBeVisible()
    await expect(page.locator(`${sel('railHeader')} .mdr-rail-setting-hint`).first()).toBeVisible()
    await page.locator(sel('showResolved')).click()
    await expect(page.locator(sel('showResolved'))).toHaveAttribute('aria-checked', 'true')
    // Escape closes the panel and gives the focus back to its button
    await page.locator(sel('policyToggle')).focus()
    await page.keyboard.press('Escape')
    await expect(page.locator(sel('showResolved'))).toBeHidden()
    await expect(page.locator(sel('railSettings'))).toBeFocused()
    expect(await page.locator(sel('railHeader')).evaluate((el) => el.getBoundingClientRect().height)).toBe(quiet)
  })

  for (const [w, h] of [[800, 700], [700, 700], [1100, 800]] as const) {
    test(`${w} px: Accept all, Reject all and the "+N above" chip each stay on one line`, async ({ page, server, tmpRoot, cli }) => {
      tmpRoot.write(FILE, DOC)
      const r = await cli.batch(FILE, {
        ops: [
          { op: 'suggest', quote: 'member rate of 12%', replace: 'member rate of 12.5%', reason: 'Updated.' },
          { op: 'suggest', quote: 'Another paragraph', replace: 'One more paragraph', reason: 'Wording.' },
        ],
      })
      expect(r.ok, r.stdout + r.stderr).toBe(true)
      await page.setViewportSize({ width: w, height: h })
      await openEditor(page, { port: server.port, file: FILE })
      await expect(page.locator(sel('acceptAllClaude'))).toBeVisible()
      const m = await page.evaluate(() => {
        // the scheduler writes this chip when cards overflow above; show it the way it would
        const chip = document.querySelector<HTMLElement>('[data-testid="mdr-overflow-chip"]')!
        chip.hidden = false
        chip.textContent = '+5 above'
        const box = (s: string) => document.querySelector(s)!.getBoundingClientRect()
        const header = document.querySelector<HTMLElement>('[data-testid="mdr-rail-header"]')!
        const main = box('.mdr-rail-head-row--main')
        return {
          accept: box('[data-testid="mdr-accept-all-claude"]').height,
          reject: box('[data-testid="mdr-reject-all-claude"]').height,
          chip: chip.getBoundingClientRect().height,
          mainRow: main.height,
          mainRight: Math.max(main.right, box('[data-testid="mdr-rail-settings"]').right),
          railRight: box('[data-testid="mdr-rail"]').right,
          headerOverflow: header.scrollWidth - header.clientWidth,
          docLabel: document.querySelector('[data-testid="mdr-doc-comment"]')!.textContent,
        }
      })
      // one text line is about 17 px: none of them wraps (a wrapped label is two lines or more)
      expect(m.accept).toBeLessThan(24)
      expect(m.reject).toBeLessThan(24)
      expect(m.chip).toBeLessThan(24)
      expect(m.mainRow).toBe(26)
      expect(m.mainRight).toBeLessThanOrEqual(m.railRight)
      expect(m.headerOverflow).toBeLessThanOrEqual(0)
      // a narrow rail says "Comment", a wide one "Comment on document"
      if (w < 1000) expect(m.docLabel).toContain('Comment')
    })
  }
})

test.describe('qa3 theme-polish: the document is named in the top bar (its file strip) and every message is dated', () => {
  const LONG = 'a-very-long-document-name-for-the-quarterly-review-draft-version-three-final.md'

  for (const w of [1440, 1280, 800, 640]) {
    test(`${w} px: a long file name ellipsizes in the bar's spare room; it never wraps the bar or moves Send`, async ({ page, server, tmpRoot }) => {
      tmpRoot.write(LONG, DOC)
      tmpRoot.write(FILE, DOC)
      await page.setViewportSize({ width: w, height: 800 })
      await openEditor(page, { port: server.port, file: FILE })
      const short = await topbar(page, w)
      await openEditor(page, { port: server.port, file: LONG })
      const long = await topbar(page, w)
      expect(long.height).toBe(short.height)
      expect(long.sendRight).toBe(short.sendRight)
      // the name lives in the file strip under the bar's row (onboarding), its absolute path the tooltip; it ellipsizes
      // inside the window, never past it
      const name = page.locator(sel('docName'))
      await expect(name).toHaveText(LONG)
      await expect(name).toHaveAttribute('title', tmpRoot.path(LONG))
      const box = await name.evaluate((el) => el.getBoundingClientRect().right)
      expect(box).toBeLessThanOrEqual(w)
    })
  }

  test('a comment card dates its first message in the head and a reply beside its author', async ({ page, server, tmpRoot, cli }) => {
    tmpRoot.write(FILE, DOC)
    const r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'member rate of 12%', body: 'Is 12% still current?' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
    await openEditor(page, { port: server.port, file: FILE })
    const card = page.locator(sel('card')).first()
    await expect(card).toContainText('Is 12% still current?')
    const time = card.locator('time').first()
    await expect(time).toHaveText(/^Today, \d{1,2}:\d{2}/)
    await expect(time).toHaveAttribute('title', /\d{4}/)
  })
})

test.describe('qa3 theme-polish: an empty document is a page you can start writing on', () => {
  test.use({ fixtureFiles: 'all' })

  test('an empty document says where to start', async ({ page, server }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ed = await openEditor(page, { port: server.port, file: 'syn__empty.md' })
    const content = (): Promise<string> => page.evaluate(() => getComputedStyle(document.querySelector('#mdr-editor-host .ProseMirror p')!, '::before').content)
    expect(await content()).toBe('"Start writing…"')
    await page.locator(sel('editor')).click()
    await page.keyboard.type('x')
    await ed.settled()
    // typing replaces the placeholder
    expect(await content()).not.toBe('"Start writing…"')
  })

  test('a click anywhere in the column of an empty document (not just its first line) puts the caret in it', async ({ page, server }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const ed = await openEditor(page, { port: server.port, file: 'syn__empty.md' })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // well below the first line, inside the column
    const col = (await page.locator('.mdr-doc-col').boundingBox())!
    await page.mouse.click(col.x + col.width / 2, 500)
    await page.keyboard.type('Hello there')
    await ed.settled()
    expect(await ed.debug.liveMarkdown()).toContain('Hello there')
  })

  test('a short document takes a click below its last line, with the caret at the end', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('tiny.md', '# Tiny\n\nShort.\n')
    await page.setViewportSize({ width: 1280, height: 800 })
    const ed = await openEditor(page, { port: server.port, file: 'tiny.md' })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const col = (await page.locator('.mdr-doc-col').boundingBox())!
    await page.mouse.click(col.x + col.width / 2, 650)
    await page.keyboard.type(' ZZ')
    await ed.settled()
    const md = await ed.debug.liveMarkdown()
    expect(md.trimEnd().endsWith('Short. ZZ')).toBe(true)
  })
})

test.describe('qa3 theme-polish: right-to-left text reads right to left', () => {
  const RTL = ['# مرحبا بالعالم', '', 'هذه فقرة بالعربية فيها كلمات كثيرة ليتضح الاتجاه.', '', '- بند أول', '- بند ثان', '', '> اقتباس بالعربية', '', 'פסקה בעברית עם מילים.', '', 'An English paragraph that stays left to right.', ''].join('\n')

  test('Arabic and Hebrew blocks are rtl and sit against the right edge of the column; English stays left', async ({ page, server, tmpRoot }) => {
    tmpRoot.write(FILE, RTL)
    await page.setViewportSize({ width: 1280, height: 900 })
    await openEditor(page, { port: server.port, file: FILE })
    const m = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-testid="mdr-editor"]')!
      const col = root.getBoundingClientRect()
      const info = (el: Element) => {
        const r = document.createRange()
        r.selectNodeContents(el)
        const t = r.getBoundingClientRect()
        return { dir: getComputedStyle(el).direction, align: getComputedStyle(el).textAlign, left: Math.round(t.left - col.left), right: Math.round(col.right - t.right) }
      }
      const q = (s: string) => root.querySelector(s)!
      const paras = Array.from(root.querySelectorAll(':scope > p'))
      return {
        h1: info(q('h1')),
        arabic: info(paras[0]!),
        li: info(q('li > p')),
        quote: info(q('blockquote > p')),
        hebrew: info(paras[1]!),
        english: info(paras[2]!),
        ruleSide: getComputedStyle(q('blockquote')).borderRightWidth + '/' + getComputedStyle(q('blockquote')).borderLeftWidth,
        listPad: getComputedStyle(q('ul')).paddingRight + '/' + getComputedStyle(q('ul')).paddingLeft,
      }
    })
    for (const k of ['h1', 'arabic', 'li', 'quote', 'hebrew'] as const) expect(m[k].dir, `${k} direction`).toBe('rtl')
    // top-level blocks end flush against the right edge of the column ...
    for (const k of ['h1', 'arabic', 'hebrew'] as const) expect(m[k].right, `${k} right gap`).toBeLessThanOrEqual(2)
    // ... and a list item or quote keeps only its indent (bullet, rule) on that side: the text is on the right, not the left
    for (const k of ['li', 'quote'] as const) {
      expect(m[k].right, `${k} right gap`).toBeLessThanOrEqual(32)
      expect(m[k].right, `${k} sits right of centre`).toBeLessThan(m[k].left)
    }
    expect(m.english.dir).toBe('ltr')
    expect(m.english.left).toBeLessThanOrEqual(2)
    // the quote's rule and the list's indent are on the right for right-to-left blocks
    expect(m.ruleSide).toBe('3px/0px')
    expect(m.listPad).toBe('28.5px/0px')
  })
})
