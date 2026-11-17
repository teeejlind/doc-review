// tests/e2e/t2-rail-doc-composer.spec.ts (Trial, TJ 2026-10-24; CONTRACTS §11.4 "Whole-document comment dock").
//
// The whole-document comment box lives in a dock at the foot of the viewport, in the rail's column, so a general comment
// can be written while the part of the document it is about stays in view. Chat keys for this box only: Enter posts,
// Cmd+Enter / Ctrl+Enter / Shift+Enter put a newline in. These specs drive the real page, server and sidecar.
import type { Locator, Page } from '@playwright/test'
import { agentHeaders } from '../helpers/startServer'
import { claude, openDoc } from './fixtures/p2'
import { railDoc, railSettled, railState, selectText, sel } from './fixtures/p3'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import type { TmpRoot } from '../helpers/tmpRoot'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const FILE = 'long.md'
const LONG = railDoc(60)

const dock = (page: Page): Locator => page.locator(sel('docComposer'))
const input = (page: Page): Locator => page.locator(sel('docComposerInput'))
const post = (page: Page): Locator => page.locator(sel('docComposerPost'))
/** The visible box (the dock itself also holds the strip of page colour under and around it). */
const card = (page: Page): Locator => dock(page).locator('.mdr-dock-card')
const scrollTo = (page: Page, to: number | 'end'): Promise<void> =>
  page.evaluate((y) => {
    const sc = document.getElementById('mdr-scroll')!
    sc.scrollTop = y === 'end' ? sc.scrollHeight : y
  }, to)
/** Scroll so the line holding `text` sits `y` px below the top of the scroll box. */
async function scrollTextTo(page: Page, text: string, y: number): Promise<void> {
  await page.evaluate(
    ([t, at]) => {
      const sc = document.getElementById('mdr-scroll')!
      const walker = document.createTreeWalker(document.querySelector('#mdr-editor-host .ProseMirror')!, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const i = n.data.indexOf(t as string)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + (t as string).length)
        // `at` is a window y below the original 48 px top bar (onboarding added the file strip, so the scroller now starts
        // lower): the word lands where these tests always put it on screen, whatever the bar's height
        sc.scrollTop += r.getBoundingClientRect().top - 48 - (at as number)
        return
      }
      throw new Error(`no text ${t}`)
    },
    [text, y] as const,
  )
  await railSettled(page, 50)
}
const scrollTop = (page: Page): Promise<number> => page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)

type DocEvent = { type?: string; body?: string; by?: string; anchor?: { kind?: string } }
/** The whole-document comments in the review file, which is what Claude reads. */
const docComments = (tmpRoot: TmpRoot, file = FILE): DocEvent[] =>
  (tmpRoot.readSidecar(file) as DocEvent[]).filter((e) => e.type === 'comment.add' && e.anchor?.kind === 'doc')

async function pending(server: { origin: string; token: string }, file = FILE): Promise<{ counts: Record<string, number>; threads: Array<{ id: string; messages?: Array<{ body: string; by: string }> }> }> {
  const r = await fetch(`${server.origin}/api/agent/pending?file=${encodeURIComponent(file)}`, { headers: agentHeaders({ token: server.token }) })
  return (await r.json()) as never
}

test.describe('the dock', () => {
  test('is on screen at every scroll position, in the rail column, one line high', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await railSettled(page, 50)
    const rail = (await page.locator('aside.mdr-rail').boundingBox())!
    for (const y of [0, 1500, 'end'] as const) {
      await scrollTo(page, y)
      await railSettled(page, 50)
      await expect(dock(page)).toBeInViewport({ ratio: 1 })
      const box = (await dock(page).boundingBox())!
      expect(Math.abs(box.x - rail.x), `left edge at ${y}`).toBeLessThanOrEqual(1)
      expect(Math.abs(box.width - rail.width), `width at ${y}`).toBeLessThanOrEqual(1)
      const c = (await card(page).boundingBox())!
      expect(900 - (c.y + c.height), `a small gap under it at ${y}`).toBeGreaterThanOrEqual(4)
      expect(900 - (c.y + c.height), `and not floating at ${y}`).toBeLessThanOrEqual(24)
      expect(c.height, 'collapsed is one line').toBeLessThan(60)
    }
    await expect(dock(page)).toHaveAttribute('data-open', 'false')
    await expect(input(page)).toHaveAttribute('placeholder', 'Comment on the document…')
    await expect(post(page)).toHaveCount(0)
  })

  test('the pinned button and the header composer are gone', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await expect(page.locator('[data-testid="mdr-doc-comment-pinned"]')).toHaveCount(0)
    await page.locator(sel('docComment')).click()
    await expect(input(page)).toBeFocused()
    // exactly one whole-document box on the page
    await expect(page.getByPlaceholder('Comment on the document…')).toHaveCount(1)
    await expect(page.locator('[data-doc-composer="true"]')).toHaveCount(0)
  })

  for (const [name, platform, hint, chord] of [
    ['macOS', 'MacIntel', 'Enter to post · ⌘↩ new line', 'Meta+Enter'],
    ['Windows', 'Win32', 'Enter to post · Ctrl+Enter new line', 'Control+Enter'],
  ] as const) {
    test(`${name}: focus opens it with the ${name} hint, and its chord puts a newline in`, async ({ page, server, tmpRoot }) => {
      await page.addInitScript((p) => Object.defineProperty(navigator, 'platform', { get: () => p }), platform)
      await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
      await input(page).click()
      await expect(dock(page)).toHaveAttribute('data-open', 'true')
      await expect(dock(page)).toContainText(hint)
      await expect(post(page)).toBeDisabled()
      await page.keyboard.type('ab')
      await expect(post(page)).toBeEnabled()
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press(chord)
      // at the caret, not at the end, and nothing was posted
      await expect(input(page)).toHaveValue('a\nb')
      expect(docComments(tmpRoot)).toHaveLength(0)
      // the caret is after the new line
      await page.keyboard.type('X')
      await expect(input(page)).toHaveValue('a\nXb')
    })
  }

  test('grows with its text up to about 40% of the window, then scrolls inside', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    const one = (await card(page).boundingBox())!.height
    await page.keyboard.type('line one')
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type(`line ${i + 2}`)
    }
    const five = (await card(page).boundingBox())!.height
    expect(five).toBeGreaterThan(one + 40)
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type(`more ${i}`)
    }
    const area = (await input(page).boundingBox())!
    expect(area.height).toBeLessThanOrEqual(900 * 0.4 + 2)
    expect(area.height).toBeGreaterThan(900 * 0.3)
    expect(await input(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    // still on the screen
    await expect(dock(page)).toBeInViewport({ ratio: 1 })
  })
})

test.describe('keys', () => {
  test('Enter posts: the thread is in the review file and in what Claude reads; the box collapses and says Posted; the document does not move', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await scrollTo(page, 1800)
    await railSettled(page, 50)
    const before = await scrollTop(page)
    await input(page).click()
    await page.keyboard.type('A general note, written while reading the middle')
    await page.keyboard.press('Enter')

    await expect.poll(() => docComments(tmpRoot).length).toBe(1)
    expect(docComments(tmpRoot)[0]).toMatchObject({ by: 'TJ', body: 'A general note, written while reading the middle' })
    const p = await pending(server)
    expect(p.counts.threads).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(p.threads)).toContain('A general note, written while reading the middle')

    await expect(input(page)).toHaveValue('')
    await expect(dock(page)).toHaveAttribute('data-open', 'false')
    await expect(dock(page)).toHaveAttribute('data-posted', 'true')
    await expect(dock(page)).toContainText('Posted')
    expect(await scrollTop(page)).toBe(before)
    // the confirmation is brief
    await expect(dock(page)).toHaveAttribute('data-posted', 'false', { timeout: 5_000 })
    await expect(dock(page)).not.toContainText('Posted')
    expect(await scrollTop(page)).toBe(before)
    // the focus went back to the text
    expect(await page.evaluate(() => !!document.activeElement?.closest('.ProseMirror'))).toBe(true)
  })

  test('the Post button posts too, and an empty or whitespace-only box never posts', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    await page.keyboard.press('Enter')
    await page.keyboard.type('   ')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Enter')
    await expect(post(page)).toBeDisabled()
    await page.waitForTimeout(400)
    expect(docComments(tmpRoot)).toHaveLength(0)
    await page.keyboard.type('x')
    await post(page).click()
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['x'])
  })

  test('Cmd+Enter (Mac) and Ctrl+Enter (Windows) and Shift+Enter are newlines, never a post', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    await page.keyboard.type('one')
    await page.keyboard.press('Meta+Enter')
    await page.keyboard.type('two')
    await page.keyboard.press('Control+Enter')
    await page.keyboard.type('three')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('four')
    await expect(input(page)).toHaveValue('one\ntwo\nthree\nfour')
    await page.waitForTimeout(300)
    expect(docComments(tmpRoot)).toHaveLength(0)
    // the draft is posted whole, newlines and all
    await page.keyboard.press('Enter')
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['one\ntwo\nthree\nfour'])
  })

  test('Cmd+Z undoes a newline put in with the chord', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    await page.keyboard.type('ab')
    await page.keyboard.press('Control+Enter')
    await expect(input(page)).toHaveValue('ab\n')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect(input(page)).toHaveValue('ab')
  })

  test('Enter during IME composition never posts (isComposing, and keyCode 229)', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    await page.keyboard.type('にほん')
    const prevented = await input(page).evaluate((el) => {
      const out: boolean[] = []
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
        const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
        el.dispatchEvent(e)
        out.push(e.defaultPrevented)
      }
      return out
    })
    // the browser keeps the Enter that picks a candidate: nobody prevented it
    expect(prevented).toEqual([false, false])
    await page.waitForTimeout(400)
    expect(docComments(tmpRoot)).toHaveLength(0)
    await expect(input(page)).toHaveValue('にほん')
    // and a real Enter after the composition ends posts
    await page.keyboard.press('Enter')
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['にほん'])
  })

  test('Esc collapses and blurs and keeps the draft; the next focus opens it again with the text', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    await page.keyboard.type('Not finished')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('second line')
    await expect(dock(page)).toHaveAttribute('data-open', 'true')
    await page.keyboard.press('Escape')
    await expect(dock(page)).toHaveAttribute('data-open', 'false')
    await expect(input(page)).not.toBeFocused()
    await expect(input(page)).toHaveValue('Not finished\nsecond line')
    expect((await card(page).boundingBox())!.height).toBeLessThan(60)
    expect(docComments(tmpRoot)).toHaveLength(0)
    // the next keystrokes go to the document, not nowhere
    expect(await page.evaluate(() => !!document.activeElement?.closest('.ProseMirror'))).toBe(true)
    await input(page).click()
    await expect(dock(page)).toHaveAttribute('data-open', 'true')
    await expect(input(page)).toHaveValue('Not finished\nsecond line')
  })
})

test.describe('Send to Claude from the dock', () => {
  for (const [name, platform, chord] of [
    ['macOS', 'MacIntel', 'Meta+Shift+Enter'],
    ['Windows', 'Win32', 'Control+Shift+Enter'],
  ] as const) {
    test(`${name}: ${chord} is Send to Claude, not a newline: the typed draft is posted first`, async ({ page, server, tmpRoot }) => {
      await page.addInitScript((p) => Object.defineProperty(navigator, 'platform', { get: () => p }), platform)
      await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
      await input(page).click()
      await page.keyboard.type('Typed, then sent')
      await page.keyboard.press(chord)
      await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['Typed, then sent'])
      await expect(input(page)).toHaveValue('')
    })
  }
})

test.describe('a post in flight', () => {
  test('text typed in the dock while the post is on its way is kept as the next draft (without the part already posted), not cleared and not shown as posted', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await page.route(/\/api\/threads\?/, async (route) => {
      if (route.request().method() === 'POST') await gate
      await route.continue()
    })
    await input(page).click()
    await page.keyboard.type('First thought')
    await page.keyboard.press('Enter')
    await expect(post(page)).toHaveText('Posting…')
    await page.keyboard.type(' and a second one')
    release()
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['First thought'])
    // what was added is still there, still being written, and nothing says it was posted; what went in is not repeated
    await expect(post(page)).toHaveText('Post')
    await expect(input(page)).toHaveValue('and a second one')
    await expect(input(page)).toBeFocused()
    await expect(dock(page)).toHaveAttribute('data-posted', 'false')
    await expect(dock(page)).toHaveAttribute('data-open', 'true')
    // and it posts as its own comment
    await page.keyboard.press('Enter')
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['First thought', 'and a second one'])
    await expect(input(page)).toHaveValue('')
  })
})

test.describe('focus and the draft', () => {
  test('the header button and Cmd+Alt+M with no selection focus the dock without scrolling anything', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await railSettled(page, 50)
    expect(await scrollTop(page)).toBe(0)
    await page.locator(sel('docComment')).click()
    await expect(input(page)).toBeFocused()
    await expect(dock(page)).toHaveAttribute('data-open', 'true')
    expect(await scrollTop(page)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(input(page)).not.toBeFocused()

    // far down the document, focus nowhere in particular: the shortcut opens it where it is
    await scrollTo(page, 2000)
    await railSettled(page, 50)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const at = await scrollTop(page)
    await page.keyboard.press('Control+Alt+m')
    await expect(input(page)).toBeFocused()
    expect(await scrollTop(page)).toBe(at)
  })

  test('typing in the document never lands in the dock, and a rail update does not take the focus', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await page.locator('#mdr-editor-host .ProseMirror p').first().click()
    await page.keyboard.type('QQ')
    await claude(server, FILE, [{ op: 'comment', quote: 'marker2x', body: 'Claude says hi' }])
    await expect(page.locator(sel('card'))).toHaveCount(1)
    await railSettled(page, 50)
    await page.keyboard.type('RR')
    await expect(input(page)).toHaveValue('')
    await expect(input(page)).not.toBeFocused()
    await expect(page.locator('#mdr-editor-host .ProseMirror').getByText('QQRR', { exact: false })).toHaveCount(1)
  })

  test('the draft survives scrolling, a mode switch and the breakpoint remount', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    await page.keyboard.type('Half a thought')
    await page.keyboard.press('Escape')
    await scrollTo(page, 900)
    await railSettled(page, 50)
    await expect(input(page)).toHaveValue('Half a thought')
    await page.locator(sel('modePill')).click()
    await railSettled(page, 50)
    await expect(input(page)).toHaveValue('Half a thought')
    // narrow and back: the dock is rebuilt in another place and keeps the text
    await page.setViewportSize({ width: 600, height: 800 })
    await expect(dock(page)).toHaveAttribute('data-narrow', 'true')
    await expect(input(page)).toHaveValue('Half a thought')
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(dock(page)).toHaveAttribute('data-narrow', 'false')
    await expect(input(page)).toHaveValue('Half a thought')
    expect(docComments(tmpRoot)).toHaveLength(0)
  })

  test('Send to Claude posts a draft left in the dock first', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await input(page).click()
    await page.keyboard.type('Typed, never posted')
    await page.keyboard.press('Escape')
    await page.locator(sel('send')).click()
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['Typed, never posted'])
    await expect(input(page)).toHaveValue('')
    await expect(dock(page)).toHaveAttribute('data-open', 'false')
  })
})

test.describe('clearance', () => {
  test('the last card is not under the dock at the bottom of the document', async ({ page, server, tmpRoot }) => {
    // thirty comments on thirty words of one line: they stack in the rail far below the end of the (short) document
    const words = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, '0')}x`)
    await openDoc(page, { port: server.port, tmpRoot, file: 'stack.md', content: `# Stack\n\n${words.join(' ')}\n` })
    await claude(server, 'stack.md', words.map((w) => ({ op: 'comment' as const, quote: w, body: `note on ${w}` })))
    await expect(page.locator(sel('card'))).toHaveCount(30)
    await railSettled(page, 150)
    await scrollTo(page, 'end')
    await railSettled(page, 150)
    const st = await railState(page)
    const sc = (await page.locator('#mdr-scroll').boundingBox())!
    const lowest = Math.max(...st.cards.filter((c) => c.placed === 'true').map((c) => c.bottom))
    const lowestInView = sc.y + (lowest - st.scrollTop)
    const dockTop = (await dock(page).boundingBox())!.y
    expect(lowestInView, 'the last card ends above the dock').toBeLessThanOrEqual(dockTop)
  })

  test('the "down" pill rides above the dock', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    const made = await claude(server, FILE, [{ op: 'comment', quote: 'marker55x', body: 'Look at the end' }])
    const thread = made.results[0]!.thread!
    const hl = page.locator(sel('highlight', { 'data-thread': thread })).first()
    await hl.scrollIntoViewIfNeeded()
    await hl.click()
    // the active card is far below the top of the document
    await scrollTo(page, 0)
    await railSettled(page, 80)
    const pill = page.locator(sel('offscreenPill'))
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-direction', 'down')
    const p = (await pill.boundingBox())!
    const d = (await dock(page).boundingBox())!
    expect(p.y + p.height, 'the pill ends above the dock').toBeLessThanOrEqual(d.y)
    expect(d.y - (p.y + p.height), 'and close to it').toBeLessThan(30)
    // the up pill keeps the top edge, with nothing pinned there
    await scrollTo(page, 'end')
    await hl.scrollIntoViewIfNeeded()
    await scrollTo(page, 'end')
    await railSettled(page, 80)
    const c = (await page.locator('#mdr-scroll').boundingBox())!
    if (await pill.isVisible()) {
      await expect(pill).toHaveAttribute('data-direction', 'up')
      expect((await pill.boundingBox())!.y - c.y).toBeLessThanOrEqual(12)
    }
  })
})

test.describe('the foot of the window', () => {
  // The dock hangs over the bottom of the rail's column. What the rail reveals (a new-comment card, a reply box) and what
  // it calls on screen (the pill) ends at the dock's top, not at the window's bottom, with the dock closed and open.
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    for (const open of [false, true]) {
      const where = `${w}x${h}, dock ${open ? 'open' : 'closed'}`

      /** The doc loaded at this size; an open dock is one holding a four-line draft (Esc has not collapsed it). */
      const ready = async (page: Page, server: { port: number }, tmpRoot: TmpRoot, file = FILE, content = LONG): Promise<void> => {
        await page.setViewportSize({ width: w, height: h })
        await openDoc(page, { port: server.port, tmpRoot, file, content })
        await railSettled(page, 50)
        if (open) {
          await input(page).click()
          await page.keyboard.type('One')
          for (const t of ['Two', 'Three', 'Four']) {
            await page.keyboard.press('Shift+Enter')
            await page.keyboard.type(t)
          }
        }
      }
      /** The box ends above the dock's top (and is on screen). */
      const clearOfDock = async (page: Page, box: Locator, label: string): Promise<void> => {
        if (open) await expect(dock(page)).toHaveAttribute('data-open', 'true')
        const b = (await box.boundingBox())!
        const d = (await dock(page).boundingBox())!
        expect(b.y, `${label}: on screen`).toBeGreaterThanOrEqual(0)
        expect(b.y + b.height, `${label}: ends at ${b.y + b.height}, the dock starts at ${d.y}`).toBeLessThanOrEqual(d.y + 0.5)
      }

      test(`${where}: Comment on text near the bottom keeps the new card's Comment and Cancel clear of the dock`, async ({ page, server, tmpRoot }) => {
        await ready(page, server, tmpRoot)
        await scrollTextTo(page, 'marker12x', h - 50)
        await selectText(page, { from: 'marker12x', reveal: false })
        await page.locator(sel('floatingComment')).click()
        const area = page.locator('[data-draft="true"] textarea')
        await expect(area).toBeFocused()
        await railSettled(page, 150)
        await clearOfDock(page, page.locator('[data-draft="true"] .mdr-composer-actions'), 'new card, right after Comment')
        // typing grows the box; the browser's own caret scroll keeps it clear as well
        await page.keyboard.type('First line,\nsecond line,\nthird line.')
        await railSettled(page, 150)
        await clearOfDock(page, page.locator('[data-draft="true"] .mdr-composer-actions'), 'new card, after three lines')
        // the scroller's own scroll-padding follows the dock's reserve while a card's box has the focus (and not in the text)
        const pad = (): Promise<number> => page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('mdr-scroll')!).scrollPaddingBottom) || 0)
        const dockH = (await dock(page).boundingBox())!.height
        expect(Math.abs((await pad()) - (dockH + 8)), `scroll-padding-bottom ${await pad()} vs the dock's ${dockH} + 8`).toBeLessThanOrEqual(1)
        await page.locator('[data-draft="true"]').getByRole('button', { name: 'Cancel' }).click()
        await expect.poll(pad).toBe(0)
      })

      test(`${where}: a reply box opened near the bottom keeps Reply and Cancel clear of the dock`, async ({ page, server, tmpRoot }) => {
        await ready(page, server, tmpRoot)
        const made = await claude(server, FILE, [{ op: 'comment', quote: 'marker14x', body: 'Is this still right?' }])
        const thread = made.results[0]!.thread!
        await scrollTextTo(page, 'marker14x', h - 230)
        await page.locator(sel('highlight', { 'data-thread': thread })).first().click()
        const cardEl = page.locator(sel('card', { 'data-thread': thread }))
        await cardEl.locator(sel('cardReply')).click()
        await railSettled(page, 150)
        await page.keyboard.type('First line of the answer,\nsecond line of the answer,\nthird line of the answer.')
        await railSettled(page, 150)
        await clearOfDock(page, cardEl.locator('.mdr-composer-actions'), 'reply box, after three lines')
      })

      test(`${where}: clicking into a reply field near the bottom brings Reply and Cancel clear of the dock before a character is typed`, async ({ page, server, tmpRoot }) => {
        await ready(page, server, tmpRoot)
        const made = await claude(server, FILE, [{ op: 'comment', quote: 'marker14x', body: 'Is this still right?' }])
        const thread = made.results[0]!.thread!
        await scrollTextTo(page, 'marker14x', h - (open ? 350 : 230))
        await page.locator(sel('highlight', { 'data-thread': thread })).first().click()
        const cardEl = page.locator(sel('card', { 'data-thread': thread }))
        await cardEl.locator(sel('cardReply')).click()
        await railSettled(page, 200)
        await expect(cardEl.locator(sel('cardReply'))).toBeFocused()
        await clearOfDock(page, cardEl.locator('.mdr-composer-actions'), 'reply box, just clicked into')
        // Tab onto the Reply button (it needs a word to be enabled) keeps it clear of the dock too
        await page.keyboard.type('Yes.')
        for (let i = 0; i < 3 && !(await cardEl.getByRole('button', { name: 'Reply' }).evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('Tab')
        await expect(cardEl.getByRole('button', { name: 'Reply' })).toBeFocused()
        await railSettled(page, 150)
        await clearOfDock(page, cardEl.locator('.mdr-composer-actions'), 'reply box, Tab onto Reply')
      })

      test(`${where}: a card that is wholly under the dock gets the "down" pill`, async ({ page, server, tmpRoot }) => {
        // thirty comments on one line stack down the rail: the twentieth card is far below its words
        const words = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, '0')}x`)
        await ready(page, server, tmpRoot, 'stack.md', `# Stack\n\n${words.join(' ')}\n`)
        const made = await claude(server, 'stack.md', words.map((w) => ({ op: 'comment' as const, quote: w, body: `note on ${w}` })))
        const thread = made.results[19]!.thread!
        await expect(page.locator(sel('card'))).toHaveCount(30)
        await page.locator(sel('highlight', { 'data-thread': thread })).first().click()
        await railSettled(page, 200)
        // scroll until the active card's top is 20px above the window's bottom edge: inside the dock's strip
        const st = await railState(page)
        const mine = st.cards.find((c) => c.thread === thread)!
        const sc = (await page.locator('#mdr-scroll').boundingBox())!
        await scrollTo(page, mine.top - (h - 20 - sc.y))
        await railSettled(page, 200)
        if (open) await expect(dock(page)).toHaveAttribute('data-open', 'true')
        const d = (await dock(page).boundingBox())!
        const c = (await page.locator(sel('card', { 'data-thread': thread })).boundingBox())!
        expect(c.y, 'the card starts under the dock').toBeGreaterThanOrEqual(d.y)
        expect(c.y, 'and on the window').toBeLessThan(h)
        const pill = page.locator(sel('offscreenPill'))
        await expect(pill).toBeVisible()
        await expect(pill).toHaveAttribute('data-direction', 'down')
        const p = (await pill.boundingBox())!
        expect(p.y + p.height, 'the pill rides above the dock').toBeLessThanOrEqual(d.y)
      })
    }
  }
})

test.describe('narrow layout', () => {
  test.use({ viewport: { width: 600, height: 800 } })

  test('spans the window above the sheet bar; the page keeps its last lines and the caret clear of it', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await railSettled(page, 50)
    await expect(page.locator('aside.mdr-rail')).toBeHidden()
    await expect(dock(page)).toHaveAttribute('data-narrow', 'true')
    const box = (await dock(page).boundingBox())!
    expect(box.x).toBe(0)
    expect(box.width).toBe(600)
    const bar = (await page.locator('.mdr-sheet-bar').boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + 1)
    expect(bar.y - (box.y + box.height)).toBeLessThanOrEqual(2)
    // matching room in the scroll box: padded for the dock, scroll-padded for the dock and the bar
    const pads = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('mdr-scroll')!)
      return { pad: parseFloat(cs.paddingBottom), scrollPad: parseFloat(cs.scrollPaddingBottom) }
    })
    expect(Math.abs(pads.pad - box.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(pads.scrollPad - (72 + box.height))).toBeLessThanOrEqual(1)
    // the last line of the document ends above the dock when scrolled to the end
    await scrollTo(page, 'end')
    const lastBottom = await page.evaluate(() => {
      const ps = document.querySelectorAll('#mdr-editor-host .ProseMirror p')
      return ps[ps.length - 1]!.getBoundingClientRect().bottom
    })
    expect(lastBottom).toBeLessThanOrEqual(box.y)
    // posting works here too, and the sheet stays shut
    await input(page).click()
    await page.keyboard.type('From a narrow window')
    await expect(dock(page)).toHaveAttribute('data-open', 'true')
    await page.keyboard.press('Enter')
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['From a narrow window'])
    await expect(page.locator(sel('sheet'))).toHaveAttribute('data-open', 'false')
  })

  test('the header button inside the open sheet puts the sheet away and focuses the dock', async ({ page, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await page.locator(sel('sheetToggle')).click()
    await expect(page.locator(sel('sheet'))).toHaveAttribute('data-open', 'true')
    await page.locator(sel('docComment')).click()
    await expect(page.locator(sel('sheet'))).toHaveAttribute('data-open', 'false')
    await expect(input(page)).toBeFocused()
    await expect(dock(page)).toBeInViewport({ ratio: 1 })
  })
})

test.describe('read-only', () => {
  test('a second tab, whose editor is read-only, treats the dock like its reply boxes and the header button: it is there and posts', async ({ page, context, server, tmpRoot }) => {
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: LONG })
    await claude(server, FILE, [{ op: 'comment', quote: 'marker2x', body: 'Which borrower?' }])
    const other = await context.newPage()
    await other.setViewportSize({ width: 1440, height: 900 })
    await openEditor(other, { port: server.port, file: FILE })
    await expect(other.locator(sel('banner', { 'data-kind': 'tab-not-leader' }))).toBeVisible()
    await expect(other.locator(sel('card')).first().locator('textarea')).toHaveCount(1)
    await expect(other.locator(sel('docComment'))).toBeEnabled()
    await expect(dock(other)).toHaveCount(1)
    await input(other).click()
    await other.keyboard.type('From the second tab')
    await other.keyboard.press('Enter')
    await expect.poll(() => docComments(tmpRoot).map((e) => e.body)).toEqual(['From the second tab'])
  })

  test('a read-only file has no dock (its reply boxes are gone too)', async ({ page, server, cli, tmpRoot }) => {
    const doc = '# Banner check\n\nThe first paragraph has a comment on it.\n\nThe second paragraph does not.\n'
    tmpRoot.write('ro.md', doc)
    let r = await cli.batch('ro.md', { ops: [{ op: 'comment', quote: 'has a comment', body: 'Still here after the damage.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    r = await cli.batch('ro.md', { ops: [{ op: 'comment', quote: 'does not', body: 'After the damaged line.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    const lines = tmpRoot.read('ro.md.review.jsonl').trimEnd().split('\n')
    lines.splice(lines.length - 1, 0, '{"seq": not json')
    tmpRoot.write('ro.md.review.jsonl', lines.join('\n') + '\n')
    await server.restart()
    await openDoc(page, { port: server.port, tmpRoot, file: 'ro.md', content: doc })
    await expect(page.locator(sel('banner', { 'data-kind': 'read-only' }))).toBeVisible()
    await expect(page.locator(sel('card')).filter({ hasText: 'Still here after the damage.' })).toHaveCount(1)
    await expect(dock(page)).toHaveCount(0)
    await expect(page.locator(sel('card')).first().locator('textarea')).toHaveCount(0)
    await expect(page.locator(sel('docComment'))).toBeDisabled()
  })
})
