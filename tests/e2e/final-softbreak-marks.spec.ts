// tests/e2e/final-softbreak-marks.spec.ts (final pass 2026-11-16, QA bug 2). Milkdown's hardbreakClearMarkPlugin
// re-created a line break with default attrs whenever a mark was added over it, so a soft line break (a plain newline
// in the .md) became a hard break (`\` + newline): a Claude suggestion across a soft break lost its deletion mark,
// left a phantom suggestion "by TJ", and the next save wrote a stray backslash. Bolding across a soft break did the same.
import { browserChoice } from '../helpers/browser'
import { claude, MOD, openDoc, placeCaret, savedText, summaries } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })
test.skip(!BROWSER.available, BROWSER.reason)

const DOC = '# Title\n\nLine one of text\nline two of text\nline three of text\n\nOutro.\n'

for (const decision of ['Accept', 'Reject'] as const) {
  test(`final: Claude's suggestion across a soft line break is one placed Claude suggestion; ${decision} writes no backslash`, async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 's.md', content: DOC })
    await claude(server, 's.md', [{ op: 'suggest', quote: 'text\nline two', replace: 'text, line two' }])
    await expect.poll(async () => (await summaries(ed)).map((s) => `${s.by}:${s.placed}`)).toEqual(['Claude:true'])
    expect(await ed.debug.liveMarkdown()).toBe(DOC)
    expect(await ed.debug.planSave()).toEqual([])
    await page.getByRole('button', { name: new RegExp(`^${decision}: `) }).first().click()
    const want = decision === 'Accept' ? DOC.replace('text\nline two', 'text, line two') : DOC
    await expect.poll(() => tmpRoot.read('s.md')).toBe(want)
    await expect.poll(async () => (await summaries(ed)).length).toBe(0)
    await placeCaret(page, 'Outro.')
    await page.keyboard.type('!')
    expect(await savedText(ed, tmpRoot, 's.md')).toBe(want.replace('Outro.', 'Outro.!'))
  })
}

test('final: bolding a selection across a soft line break keeps it a soft break', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'b.md', content: DOC })
  // select from "text" at the end of line one to "line" at the start of line two
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    root.focus()
    const ps = root.querySelectorAll('p')
    const p = ps[0]!
    const first = p.firstChild!
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    walker.nextNode()
    const second = walker.nextNode()!
    window.getSelection()!.setBaseAndExtent(first, 'Line one of '.length, second, 'line'.length)
  })
  await page.waitForTimeout(100)
  await page.keyboard.press(`${MOD}+b`)
  const out = await savedText(ed, tmpRoot, 'b.md')
  expect(out).not.toContain('\\')
  expect(out.split('\n').slice(2, 5).map((l) => l.replace(/\*/g, ''))).toEqual(['Line one of text', 'line two of text', 'line three of text'])
})
