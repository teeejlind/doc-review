// tests/e2e/trial-softbreaks-sticky.spec.ts (Trial, TJ 2026-10-23, newsletter #209 APPROVE.md review).
//
// 1. Soft breaks: consecutive source lines with no blank line between them (one CommonMark paragraph) showed joined,
//    because Milkdown paints the soft break as a space. Each line now shows on its own line, the file stays byte for
//    byte what it was (open, save, an edit elsewhere), and a suggestion across a soft break still places and applies.
// (The second Trial fix, a doc-level Comment that stays in view, became the whole-document dock at the foot of the rail:
// tests/e2e/t2-rail-doc-composer.spec.ts.)
import type { Page } from '@playwright/test'
import { claude, openDoc, placeCaret, savedText, summaries } from './fixtures/p2'
import { selectText, sel } from './fixtures/p3'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [] })

const FILE = 'approve.md'
const HEADER = [
  '# Newsletter #209: approval',
  '',
  '**Sends:** Saturday 10/24, 9:00 AM ET',
  '**TJ:** approve the copy below',
  '**Status:** draft only',
  '**Preview:** see the PDF',
  '',
  'Body paragraph that TJ edits.',
  '',
].join('\n')

/** Top of the first line box holding `text` in the editor (px, viewport). */
function lineTop(page: Page, text: string): Promise<number> {
  return page.evaluate((t) => {
    const root = document.querySelector('#mdr-editor-host .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const i = n.data.indexOf(t)
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + t.length)
      return r.getClientRects()[0]!.top
    }
    throw new Error(`no text ${t}`)
  }, text)
}

test.describe('soft breaks show as line breaks', () => {
  test('each source line of one paragraph sits on its own line', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: HEADER })
    await expect(page.locator('#mdr-editor-host br[data-is-inline="true"]')).toHaveCount(3)
    const tops = await Promise.all(['Sends:', 'TJ:', 'Status:', 'Preview:'].map((t) => lineTop(page, t)))
    for (let i = 1; i < tops.length; i++) expect(tops[i]!, `line ${i + 1} below line ${i}`).toBeGreaterThan(tops[i - 1]! + 5)
  })

  test('the file is byte for byte unchanged after open and save, and an edit elsewhere leaves the header lines alone', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: HEADER })
    expect(await savedText(ed, tmpRoot, FILE)).toBe(HEADER)
    await placeCaret(page, 'TJ edits.')
    await page.keyboard.type(' More.')
    await expect.poll(() => savedText(ed, tmpRoot, FILE)).toBe(HEADER.replace('TJ edits.', 'TJ edits. More.'))
  })

  test('a suggestion across a soft break places and applies', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: HEADER })
    const r = await claude(server, FILE, [{ op: 'suggest', quote: 'copy below\n**Status:** draft', replace: 'copy below\n**Status:** final' }])
    const id = r.results[0]!.suggestion!
    await expect.poll(async () => (await summaries(ed)).filter((s) => s.placed && s.id === id).length).toBe(1)
    expect(await ed.bridge((br, s) => br.accept(s), id)).toMatchObject({ ok: true })
    await expect.poll(() => savedText(ed, tmpRoot, FILE)).toBe(HEADER.replace('**Status:** draft only', '**Status:** final only'))
  })

  test('TJ can select across a soft break and comment on it', async ({ page, server, tmpRoot }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: HEADER })
    await selectText(page, { from: 'copy below', to: 'draft only' })
    await page.locator(sel('floatingComment')).click()
    await expect(page.locator(`${sel('cardReply')}:focus`)).toHaveCount(1)
    await page.keyboard.type('Two lines, one comment.')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect.poll(() => ed.session((s) => s.getReview().threads.length)).toBe(1)
    const quote = await ed.session((s) => (s.getReview().threads[0]!.anchor as { quote?: string }).quote ?? '')
    expect(quote).toContain('copy below')
    expect(quote).toContain('draft only')
    await expect(page.locator(sel('highlight')).first()).toBeVisible()
    expect(await savedText(ed, tmpRoot, FILE)).toBe(HEADER)
  })
})
