// tests/e2e/qa2-d-sheet.spec.ts (QA round 2, agent D; QA_FINDINGS confirmed 4, 5, 19, 21, 29, and the Accept click in
// the sheet). The bottom sheet is only used below 640 px (NARROW_BREAKPOINT_PX); the cases here run at 600 px.
import type { Page } from '@playwright/test'
import { TESTID } from '../../shared/constants'
import { openEditor } from '../helpers/openEditor'
import { claude, LINE_END } from './fixtures/p2'
import { railDoc, selectText } from './fixtures/p3'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: ['basic.md'], viewport: { width: 600, height: 800 } })

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const sel = (id: string) => `[data-testid="${id}"]`

function longDoc(): string {
  const long = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i} keeps the document tall enough to scroll in this viewport.`).join('\n\n')
  return `# Long\n\n${long}\n\nThe fee is 1.5% per year.\n\n${long}\n`
}

test.describe('qa2-d: the Accept button in the sheet', () => {
  test('a folded card keeps its buttons out of reach; tapping the card opens it and a real click on Accept lands', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('long.md', longDoc())
    await openEditor(page, { port: server.port, file: 'long.md' })
    const r = await claude(server, 'long.md', [{ op: 'suggest', quote: 'The fee is 1.5% per year.', replace: 'The fee is 1.25% per year.', reason: 'Lower fee.' }])
    const thread = r.results[0]!.thread!
    await page.locator('#mdr-editor-host p').first().click()
    await page.locator(sel(TESTID.sheetToggle)).click()
    const card = page.locator(`${sel(TESTID.card)}[data-thread="${thread}"]`)
    await expect(card).toHaveAttribute('data-collapsed', 'true')
    const accept = card.locator(sel(TESTID.accept))
    // folded: the card clips its body, so its buttons must not be there to hit (a pointer-down on a clipped button
    // would unfold the card under the cursor and lose the click)
    await expect(accept).toBeHidden()
    await card.click({ position: { x: 20, y: 12 } })
    await expect(card).toHaveAttribute('data-collapsed', 'false')
    await expect(accept).toBeVisible()
    // the button is inside the sheet's visible area, not below the window
    const box = (await accept.boundingBox())!
    const body = (await page.locator('.mdr-sheet-body').boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(body.y - 1)
    expect(box.y + box.height).toBeLessThanOrEqual(body.y + body.height + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(800)
    await accept.click({ timeout: 3000 })
    await expect(page.locator('.mdr-sugg--ins')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.getElementById('mdr-editor-host')!.textContent ?? ''))
      .toContain('The fee is 1.25% per year.')
  })
})

/** Where the active comment's first line is, against the strip of document above the sheet (all in viewport px). */
async function strip(page: Page, thread: string): Promise<{ top: number; bottom: number; viewTop: number; sheetTop: number; sheetMaxTop: number; scrollTop: number } | null> {
  return page.evaluate((th) => {
    const hl = document.querySelector(`[data-testid="mdr-highlight"][data-thread="${th}"], .mdr-sugg[data-thread="${th}"]`)
    const r = hl?.getClientRects()[0]
    if (!r) return null
    const sheet = document.querySelector('.mdr-sheet')!
    const sc = document.getElementById('mdr-scroll')!
    // the sheet never grows past its max-height, so this is the smallest strip the document can have above it
    const maxH = parseFloat(getComputedStyle(sheet).maxHeight)
    return { top: r.top, bottom: r.bottom, viewTop: sc.getBoundingClientRect().top, sheetTop: sheet.getBoundingClientRect().top, sheetMaxTop: innerHeight - maxH, scrollTop: sc.scrollTop }
  }, thread)
}

async function commented(page: Page, server: Parameters<typeof claude>[0], tmpRoot: { write(f: string, t: string): void }, markers: string[]) {
  tmpRoot.write('rail.md', railDoc(36))
  await openEditor(page, { port: server.port, file: 'rail.md' })
  const r = await claude(server, 'rail.md', markers.map((m, i) => ({ op: 'comment' as const, quote: m, body: `Comment ${i + 1} on ${m}.` })))
  const threads = r.results.map((x) => x.thread!)
  await expect(page.locator(`${sel(TESTID.highlight)}[data-thread="${threads.at(-1)}"]`).first()).toBeAttached()
  return threads
}

const expectAbove = async (page: Page, thread: string): Promise<void> => {
  await expect
    .poll(async () => {
      const s = await strip(page, thread)
      if (!s) return 'no highlight'
      // first line below the top bar, and its bottom above the sheet at its tallest
      return s.top >= s.viewTop && s.bottom <= s.sheetMaxTop + 1 && s.bottom <= s.sheetTop + 1 ? 'above the sheet' : JSON.stringify(s)
    })
    .toBe('above the sheet')
}

test.describe('qa2-d: the anchored text stays above the sheet (confirmed 4, 19)', () => {
  test('next comment opens the sheet with the anchor in the strip above it, every time', async ({ page, server, tmpRoot }) => {
    const threads = await commented(page, server, tmpRoot, ['marker4x', 'marker14x', 'marker24x', 'marker32x'])
    for (const t of threads) {
      await page.locator(sel(TESTID.navNext)).click()
      await expect(page.locator(`${sel(TESTID.card)}[data-thread="${t}"]`)).toHaveAttribute('data-active', 'true')
      await expectAbove(page, t)
    }
    // and back up with previous
    await page.locator(sel(TESTID.navPrev)).click()
    await expect(page.locator(`${sel(TESTID.card)}[data-thread="${threads[2]}"]`)).toHaveAttribute('data-active', 'true')
    await expectAbove(page, threads[2]!)
  })

  test('tapping commented text keeps the caret in the editor and lifts the text above the sheet', async ({ page, server, tmpRoot }) => {
    const threads = await commented(page, server, tmpRoot, ['marker4x', 'marker14x', 'marker24x'])
    const t = threads[1]!
    const hl = page.locator(`${sel(TESTID.highlight)}[data-thread="${t}"]`).first()
    // the commented text sits low on the screen: where the open sheet would cover it
    await page.evaluate((th) => {
      const sc = document.getElementById('mdr-scroll')!
      const el = document.querySelector(`[data-testid="mdr-highlight"][data-thread="${th}"]`)!
      sc.scrollTop += el.getBoundingClientRect().top - 620
    }, t)
    await hl.click()
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'true')
    await expect(page.locator(`${sel(TESTID.card)}[data-thread="${t}"]`)).toHaveAttribute('data-active', 'true')
    await expectAbove(page, t)
    // the caret is still in the document: TJ can type into the commented text
    const where = await page.evaluate(() => ({ inEditor: !!document.activeElement?.closest('#mdr-editor-host'), tag: document.activeElement?.tagName }))
    expect(where, JSON.stringify(where)).toMatchObject({ inEditor: true })
  })

  test('tapping a card for a change lower in the document brings that change above the sheet', async ({ page, server, tmpRoot }) => {
    const threads = await commented(page, server, tmpRoot, ['marker4x', 'marker14x', 'marker24x', 'marker32x'])
    await page.locator(sel(TESTID.sheetToggle)).click()
    const last = threads.at(-1)!
    const card = page.locator(`${sel(TESTID.card)}[data-thread="${last}"]`)
    await card.scrollIntoViewIfNeeded()
    await card.click({ position: { x: 20, y: 12 } })
    await expect(card).toHaveAttribute('data-active', 'true')
    await expectAbove(page, last)
    // replying leaves it there
    const before = (await strip(page, last))!.scrollTop
    await card.locator(sel(TESTID.cardReply)).click()
    await page.keyboard.type('A reply that is typed while the text is in view.')
    await page.waitForTimeout(300)
    expect((await strip(page, last))!.scrollTop).toBe(before)
    await expectAbove(page, last)
  })
})

test.describe('qa2-d: the sheet gets out of the way of the document', () => {
  const textRect = (page: Page, needle: string) =>
    page.evaluate((n) => {
      const walker = document.createTreeWalker(document.getElementById('mdr-editor-host')!, NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        const i = t.data.indexOf(n)
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(t, i)
        range.setEnd(t, i + n.length)
        const r = range.getBoundingClientRect()
        const sheet = document.querySelector('.mdr-sheet')!
        const maxH = parseFloat(getComputedStyle(sheet).maxHeight)
        return { top: r.top, bottom: r.bottom, viewTop: document.getElementById('mdr-scroll')!.getBoundingClientRect().top, sheetMaxTop: innerHeight - maxH }
      }
      return null
    }, needle)

  test('Comment on text low on the screen: the selection ends up above the sheet and the composer has the focus', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('rail.md', railDoc(36))
    await openEditor(page, { port: server.port, file: 'rail.md' })
    await selectText(page, { from: 'marker20x' })
    // put the selection low on the screen, where the open sheet would cover it
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.getElementById('mdr-editor-host')!, NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        const i = t.data.indexOf('marker20x')
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(t, i)
        range.setEnd(t, i + 9)
        document.getElementById('mdr-scroll')!.scrollTop += range.getBoundingClientRect().top - 640
        return
      }
    })
    await page.waitForTimeout(200)
    await page.locator(sel(TESTID.commentButton)).click()
    const area = page.locator(`${sel(TESTID.card)}[data-draft="true"] ${sel(TESTID.cardReply)}`)
    await expect(area).toBeFocused()
    await expect
      .poll(async () => {
        const r = (await textRect(page, 'marker20x'))!
        return r.top >= r.viewTop && r.bottom <= r.sheetMaxTop + 1
      })
      .toBe(true)
  })

  test('a tap in plain text puts the sheet away, and the caret stays where it was tapped', async ({ page, server, tmpRoot }) => {
    await commented(page, server, tmpRoot, ['marker4x'])
    await page.locator(sel(TESTID.sheetToggle)).click()
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'true')
    await page.locator(sel(TESTID.sheet)).press('Escape')
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'false')
    // open on a thread, then tap in plain text
    await page.locator(`${sel(TESTID.highlight)}`).first().click()
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'true')
    await page.locator('#mdr-editor-host h1').click()
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'false')
  })

  test('typing in the document puts the sheet away; Esc with the caret in the document does too and leaves the selection alone', async ({ page, server, tmpRoot }) => {
    await commented(page, server, tmpRoot, ['marker4x'])
    const hl = page.locator(`${sel(TESTID.highlight)}`).first()
    await hl.click()
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'true')
    const selBefore = await page.evaluate(() => document.getSelection()!.toString() + '|' + document.getSelection()!.anchorOffset)
    await page.keyboard.press('Escape')
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'false')
    expect(await page.evaluate(() => document.getSelection()!.toString() + '|' + document.getSelection()!.anchorOffset)).toBe(selBefore)
    await hl.click()
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'true')
    await page.keyboard.type('Q')
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'false')
    await expect(page.locator('#mdr-editor-host')).toContainText('Q')
  })
})

test.describe('qa2-d: the line being typed stays above the Comments bar (confirmed 21)', () => {
  test('typing new lines at the end of the doc never slides the caret line under the bar', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('type.md', railDoc(6))
    await openEditor(page, { port: server.port, file: 'type.md' })
    await page.locator('#mdr-editor-host p').last().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    const caret = () =>
      page.evaluate(() => {
        const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect()
        const bar = document.querySelector('.mdr-sheet-bar')!.getBoundingClientRect()
        const sc = document.getElementById('mdr-scroll')!.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, barTop: bar.top, scTop: sc.top, h: r.height }
      })
    const worst: string[] = []
    for (let i = 0; i < 45; i++) {
      // soft breaks: one line (about 30 px) at a time, so the caret crosses the bar's 48 px band for sure
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type(`Typed line ${i}`)
      const c = await caret()
      if (c.h > 0 && (c.bottom > c.barTop + 0.5 || c.top < c.scTop)) worst.push(`line ${i}: caret ${c.top.toFixed(0)}-${c.bottom.toFixed(0)} bar ${c.barTop.toFixed(0)}`)
    }
    expect(worst, worst.slice(0, 3).join('; ')).toEqual([])
  })

  test('arrowing down through the document keeps the caret line above the bar too', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('arrow.md', railDoc(30))
    await openEditor(page, { port: server.port, file: 'arrow.md' })
    await page.locator('#mdr-editor-host p').first().click()
    const bad: string[] = []
    for (let i = 0; i < 70; i++) {
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(30)
      const c = await page.evaluate(() => {
        const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect()
        return { bottom: r.bottom, h: r.height, barTop: document.querySelector('.mdr-sheet-bar')!.getBoundingClientRect().top }
      })
      if (c.h > 0 && c.bottom > c.barTop + 0.5) bad.push(`${i}: ${c.bottom.toFixed(0)} > ${c.barTop.toFixed(0)}`)
    }
    expect(bad, bad.slice(0, 3).join('; ')).toEqual([])
  })
})

test.describe('qa2-d: unsent text and focus survive the 640 px breakpoint (confirmed 5)', () => {
  const replyBox = (page: Page, thread: string) => page.locator(`${sel(TESTID.card)}[data-thread="${thread}"] ${sel(TESTID.cardReply)}`)

  test('half-typed replies (and the focus) cross from the rail to the sheet and back', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 800, height: 800 })
    const [a, b] = await commented(page, server, tmpRoot, ['marker4x', 'marker6x'])
    // an unsent reply on the first thread, then the second one is the one being typed
    await page.locator(`${sel(TESTID.highlight)}[data-thread="${a}"]`).first().click()
    await replyBox(page, a!).click()
    await page.keyboard.type('First half-typed reply. ')
    await page.locator(`${sel(TESTID.highlight)}[data-thread="${b}"]`).first().click()
    await replyBox(page, b!).click()
    await page.keyboard.type('Second half-typed reply. ')
    await expect(replyBox(page, b!)).toBeFocused()

    // the window shrinks past the breakpoint: the cards move into the sheet
    await page.setViewportSize({ width: 600, height: 800 })
    await expect(page.locator(sel(TESTID.sheet))).toBeVisible()
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'true')
    await expect(replyBox(page, b!)).toHaveValue('Second half-typed reply. ')
    await expect(replyBox(page, b!)).toBeFocused()
    await page.keyboard.type('more')
    await expect(replyBox(page, b!)).toHaveValue('Second half-typed reply. more')
    // the other card's reply is still there once its card unfolds, and that is where TJ goes next
    await page.locator(`${sel(TESTID.card)}[data-thread="${a}"]`).click({ position: { x: 20, y: 12 } })
    await expect(replyBox(page, a!)).toHaveValue('First half-typed reply. ')
    await replyBox(page, a!).click()
    await expect(replyBox(page, a!)).toBeFocused()

    // and back out to the rail
    await page.setViewportSize({ width: 800, height: 800 })
    await expect(page.locator(sel(TESTID.sheet))).toHaveCount(0)
    await expect(replyBox(page, a!)).toHaveValue('First half-typed reply. ')
    await expect(replyBox(page, b!)).toHaveValue('Second half-typed reply. more')
    await expect(replyBox(page, a!)).toBeFocused()
    await page.keyboard.type('!')
    await expect(replyBox(page, a!)).toHaveValue('First half-typed reply. !')
  })

  test('a new-comment draft keeps its focus across the breakpoint too', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 800, height: 800 })
    tmpRoot.write('rail.md', railDoc(12))
    await openEditor(page, { port: server.port, file: 'rail.md' })
    await selectText(page, { from: 'marker3x' })
    await page.locator(sel(TESTID.commentButton)).click()
    const area = page.locator(`${sel(TESTID.card)}[data-draft="true"] ${sel(TESTID.cardReply)}`)
    await expect(area).toBeFocused()
    await page.keyboard.type('Draft before the resize. ')
    await page.setViewportSize({ width: 600, height: 800 })
    await expect(page.locator(sel(TESTID.sheet))).toHaveAttribute('data-open', 'true')
    await expect(area).toHaveValue('Draft before the resize. ')
    await expect(area).toBeFocused()
    await page.setViewportSize({ width: 800, height: 800 })
    await expect(area).toHaveValue('Draft before the resize. ')
    await expect(area).toBeFocused()
  })
})

test.describe('qa2-d: Undo and the mode keys work without clicking the document first (confirmed 29)', () => {


  for (const w of [1440, 600]) {
    test(`${w} px: after Accept on a card the focus is back in the document`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: 900 })
      void tmpRoot
      await openEditor(page, { port: server.port, file: 'basic.md' })
      const r = await claude(server, 'basic.md', [{ op: 'suggest', quote: 'reviewed every quarter', replace: 'reviewed every month' }])
      const thread = r.results[0]!.thread!
      await expect(page.locator('.mdr-sugg--ins').first()).toBeVisible()
      if (w < 640) await page.locator(sel(TESTID.sheetToggle)).click()
      const card = page.locator(`${sel(TESTID.card)}[data-thread="${thread}"]`)
      const accept = card.locator(sel(TESTID.accept))
      if (!(await accept.isVisible())) await card.click({ position: { x: 20, y: 12 } })
      const scrollOf = () => page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)
      const before = await scrollOf()
      await accept.click()
      await expect(page.locator('.mdr-sugg--ins')).toHaveCount(0)
      // not on BODY: Cmd+Z and Cmd+Shift+Z have somewhere to go, and getting there scrolled nothing
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#mdr-editor-host'))).toBe(true)
      expect(Math.abs((await scrollOf()) - before)).toBeLessThanOrEqual(1)
    })
  }

  test('Cmd+Z and Cmd+Shift+Z reach the document while nothing has the focus', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: 'basic.md' })
    await page.getByText('We launch in Q3.').click()
    await page.keyboard.press(LINE_END)
    await page.keyboard.type(' Soon.')
    await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Soon.')
    // the focus falls to the page body (what a removed button leaves behind)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
    await page.keyboard.press(`${MOD}+KeyZ`)
    await expect.poll(() => ed.debug.liveMarkdown()).not.toContain('Soon.')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press(`${MOD}+Shift+KeyZ`)
    await expect.poll(() => ed.debug.liveMarkdown()).toContain('We launch in Q3. Soon.')
  })

  test('a fresh page: Cmd+Opt+Shift+X switches to Suggesting without a click in the document', async ({ page, server }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openEditor(page, { port: server.port, file: 'basic.md' })
    // the editor takes the focus on open now (QA3); this case is about the keys with nothing focused
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
    await page.keyboard.press(`${MOD}+Alt+Shift+KeyX`)
    await expect(ed.editor()).toHaveAttribute('data-mode', 'suggesting')
    await page.keyboard.press(`${MOD}+Alt+Shift+KeyE`)
    await expect(ed.editor()).toHaveAttribute('data-mode', 'editing')
  })

  test('clicking into a reply box still never scrolls the document, and typing there is not hijacked', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const threads = await commented(page, server, tmpRoot, ['marker4x', 'marker24x'])
    const scrollOf = () => page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)
    const box = page.locator(`${sel(TESTID.card)}[data-thread="${threads[1]}"] ${sel(TESTID.cardReply)}`)
    await page.locator(`${sel(TESTID.highlight)}[data-thread="${threads[1]}"]`).first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const before = await scrollOf()
    await box.click()
    await page.keyboard.type('z with the box focused')
    await page.keyboard.press(`${MOD}+KeyZ`)
    await expect(box).toBeFocused()
    expect(Math.abs((await scrollOf()) - before)).toBeLessThanOrEqual(1)
  })
})
