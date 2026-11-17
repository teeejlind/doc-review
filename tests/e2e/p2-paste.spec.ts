// tests/e2e/p2-paste.spec.ts (P2; CONTRACTS §12.11). The paste fixtures in real Chromium: each
// tests/unit/web/editor/paste/fixtures/<source>-<case>.html is pasted (a ClipboardEvent carrying text/html, through
// ProseMirror's own paste path and Chromium's DOM parser) into an empty doc and saved; the file must equal the
// sibling .md, as in the jsdom unit test. Plus Cmd+Shift+V plain paste, a lone URL over a selection, the dropped-image
// notice, and the Suggesting-mode table block.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { browserChoice } from '../helpers/browser'
import { captureNotices, notices, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const DIR = join(process.cwd(), 'tests/unit/web/editor/paste/fixtures')
const CASES = readdirSync(DIR).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -'.html'.length)).sort()

/** Dispatch a paste event with the given clipboard flavours on the editor (ProseMirror reads event.clipboardData). */
async function paste(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((d) => {
    const dom = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    dom.focus()
    const dt = new DataTransfer()
    for (const [k, v] of Object.entries(d)) dt.setData(k, v)
    dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
  await page.waitForTimeout(50)
}

test.describe('fixtures', () => {
  for (const name of CASES) {
    test(`p2-paste: ${name}`, async ({ page, server, tmpRoot }) => {
      const file = `${name}.md`
      const ed = await openDoc(page, { port: server.port, tmpRoot, file, content: '' })
      await paste(page, { 'text/html': readFileSync(join(DIR, `${name}.html`), 'utf8'), 'text/plain': 'plain fallback' })
      expect(await savedText(ed, tmpRoot, file)).toBe(readFileSync(join(DIR, `${name}.md`), 'utf8'))
    })
  }
})

test('p2-paste: Cmd+Shift+V inserts text/plain only; a lone URL over a selection links it', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'p.md', content: 'Start.\n\nRead the primer today.\n' })
  await placeCaret(page, 'Start.')
  // the shortcut's keydown (synthetic, so the browser runs no native paste of its own), then the paste event
  await page.evaluate(() => {
    const dom = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    const mac = /Mac/.test(navigator.platform)
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', shiftKey: true, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }))
  })
  await paste(page, { 'text/html': '<p><b>rich</b></p>', 'text/plain': ' one\nline two\n\nSecond para' })
  expect(await savedText(ed, tmpRoot, 'p.md')).toBe('Start. one\nline two\n\nSecond para\n\nRead the primer today.\n')
  await placeCaret(page, 'primer', 'select')
  await paste(page, { 'text/plain': 'https://example.com/primer' })
  expect(await savedText(ed, tmpRoot, 'p.md')).toBe('Start. one\nline two\n\nSecond para\n\nRead the [primer](https://example.com/primer) today.\n')
})

test('p2-paste: dropped images raise PASTE_IMAGE_DROPPED; a table paste is blocked in Suggesting mode', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'p.md', content: 'Para.\n' })
  await captureNotices(ed)
  await placeCaret(page, 'Para.')
  await paste(page, { 'text/html': '<p>x <img src="data:image/png;base64,iVBORw0KGgo="></p>' })
  expect(await notices(page)).toContain('PASTE_IMAGE_DROPPED')
  const before = await savedText(ed, tmpRoot, 'p.md')
  await ed.testid('modePill').click()
  await placeCaret(page, 'Para.')
  await paste(page, { 'text/html': '<table><tr><th>a</th></tr><tr><td>b</td></tr></table>' })
  expect((await notices(page)).filter((c) => c === 'SUGGEST_MODE_BLOCKED').length).toBe(1)
  expect(await page.locator('#mdr-editor-host .ProseMirror table').count()).toBe(0)
  expect(await savedText(ed, tmpRoot, 'p.md')).toBe(before)
})
