// tests/e2e/t2-editor-ux-windows.spec.ts (T2 editor-ux): Pass 4 #21 and #35 in a real browser that reports Windows.
// Windows can't run here, so the page is told navigator.platform is Win32 (and the user agent to match) before any of
// its code loads. prosemirror-keymap reads the platform once at import, so this is the same page a Windows user gets.
import { browserChoice } from '../helpers/browser'
import { claude, openDoc, placeCaret } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const LINE = 'Change the middle word here.\n'

test.beforeEach(async ({ page }) => {
  await page.addInitScript((ua) => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', configurable: true })
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => ua, configurable: true })
  }, WINDOWS_UA)
})

test('#35: Ctrl+Alt+Shift+X switches to Suggesting and Ctrl+Alt+Shift+E back, the chords the pill advertises', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: LINE })
  expect(await page.evaluate(() => navigator.platform)).toBe('Win32')
  const pill = ed.testid('modePill')
  await expect(pill).toHaveAttribute('title', /\(Ctrl\+Alt\+Shift\+X\)/)
  await placeCaret(page, 'middle')
  await page.keyboard.press('Control+Alt+Shift+KeyX')
  await expect(pill).toHaveAttribute('data-mode', 'suggesting')
  await expect(pill).toHaveAttribute('title', /\(Ctrl\+Alt\+Shift\+E\)/)
  await page.keyboard.press('Control+Alt+Shift+KeyE')
  await expect(pill).toHaveAttribute('data-mode', 'editing')
  // with nothing focused (the card's Accept just took the focus away) the chord still reaches the editor
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+Alt+Shift+KeyX')
  await expect(pill).toHaveAttribute('data-mode', 'suggesting')
})

test('#21: no shortcut hint on the page shows a Mac glyph', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: LINE })
  await claude(server, 'k.md', [{ op: 'comment', quote: 'middle', body: 'Which word?' }])
  await expect(ed.testid('card')).toHaveCount(1)
  await expect(ed.testid('commentButton')).toHaveAttribute('title', 'Select text to comment on it (Ctrl+Alt+M)')
  await expect(ed.testid('navPrev')).toHaveAttribute('title', 'Previous comment (Ctrl+Alt+[)')
  await expect(ed.testid('navNext')).toHaveAttribute('title', 'Next comment (Ctrl+Alt+])')
  await expect(ed.testid('send')).toHaveAttribute('title', 'Send to Claude (Ctrl+Enter in the document, Ctrl+Shift+Enter anywhere)')
  await expect(ed.testid('toolbarButton', { 'data-action': 'bold' })).toHaveAttribute('title', 'Bold (Ctrl+B)')

  // the floating Comment button that appears beside a selection
  await placeCaret(page, 'word', 'select')
  await expect(ed.testid('floatingComment')).toBeVisible()
  await expect(ed.testid('floatingComment')).toHaveAttribute('title', 'Comment (Ctrl+Alt+M)')

  const glyphs = await page.evaluate(() =>
    [...document.querySelectorAll('[title], [aria-label]')]
      .flatMap((el) => [el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? ''])
      .filter((t) => /[⌘⌥⇧↩]/.test(t)),
  )
  expect(glyphs).toEqual([])
})

test('#21: a Mac still reads the glyphs', async ({ page, server, tmpRoot }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true })
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', configurable: true })
  })
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: LINE })
  await expect(ed.testid('commentButton')).toHaveAttribute('title', 'Select text to comment on it (⌘⌥M)')
  await expect(ed.testid('send')).toHaveAttribute('title', 'Send to Claude (⌘↩ in the document, ⌘⇧↩ anywhere)')
  await expect(ed.testid('toolbarButton', { 'data-action': 'bold' })).toHaveAttribute('title', 'Bold (⌘B)')
  await expect(ed.testid('modePill')).toHaveAttribute('title', /\(⌘⌥⇧X\)/)
})
