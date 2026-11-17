// tests/e2e/qa2-a-blocks.spec.ts (QA round 2, agent A: confirmed 17 and 16).
//
// Block-level suggestions from Claude on the real stack: two of them that each add or remove a block both render inline
// (neither falls into "Can't place this inline"), and adding a list item or a blockquote line marks only the new child.
import { TESTID } from '../../shared/constants'
import { openEditor } from '../helpers/openEditor'
import { claude, placeCaret } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: ['basic.md'], viewport: { width: 1440, height: 900 } })

const DOC = '# T\n\nSecond paragraph stays as is.\n\n- Alpha item\n- Beta item\n- Gamma item\n\nClosing paragraph.\n'
const OPS = {
  listAdd: { op: 'suggest', quote: 'Gamma item', replace: 'Gamma item\n- Delta item', reason: 'Add a bullet.' },
  paraAdd: { op: 'suggest', quote: 'Second paragraph stays as is.', replace: 'Second paragraph stays as is.\n\nA brand new paragraph follows.', reason: 'Add a paragraph.' },
  paraDel: { op: 'suggest', quote: 'Closing paragraph.', replace: '', reason: 'Drop it.' },
} as const

test.describe('qa2: two block-level suggestions in one doc', () => {
  const pairs: Array<[keyof typeof OPS, keyof typeof OPS]> = [['listAdd', 'paraAdd'], ['listAdd', 'paraDel'], ['paraAdd', 'listAdd'], ['paraDel', 'listAdd']]
  for (const [a, b] of pairs) {
    test(`${a} then ${b}: both render inline, nothing unplaced`, async ({ page, server, tmpRoot }) => {
      tmpRoot.write('blocks.md', DOC)
      await openEditor(page, { port: server.port, file: 'blocks.md' })
      const r = await claude(server, 'blocks.md', [OPS[a], OPS[b]])
      const ids = r.results.map((x) => x.suggestion!)
      for (const id of ids) await expect(page.locator(`#mdr-editor-host [data-suggestion="${id}"], #mdr-editor-host .mdr-sugg[data-suggestion="${id}"]`).first()).toBeAttached()
      await expect(page.locator(`[data-testid="${TESTID.suggestionItem}"][data-state="unplaced"]`)).toHaveCount(0)
      await expect(page.locator(`[data-testid="${TESTID.unplacedSection}"]`)).toHaveCount(0)
      // a fresh load shows the same (hydration from the stored records)
      await openEditor(page, { port: server.port, file: 'blocks.md' })
      for (const id of ids) await expect(page.locator(`#mdr-editor-host [data-suggestion="${id}"]`).first()).toBeAttached()
      await expect(page.locator(`[data-testid="${TESTID.suggestionItem}"][data-state="unplaced"]`)).toHaveCount(0)
    })
  }
})

/** The text of every struck and every inserted run in the doc (a marked block and the marked text inside it count once). */
async function marked(page: import('@playwright/test').Page): Promise<{ del: string[]; ins: string[] }> {
  return page.evaluate(() => {
    const texts = (sel: string) =>
      Array.from(document.querySelectorAll(`#mdr-editor-host ${sel}`))
        .filter((e) => !e.parentElement?.closest(sel))
        .map((e) => (e.textContent ?? '').replace(/​/g, ''))
        .filter((t) => t !== '')
    return { del: texts('.mdr-sugg--del'), ins: texts('.mdr-sugg--ins') }
  })
}

test.describe('qa2: adding or removing a list item or blockquote line marks only that child', () => {
  test('Claude adds a bullet: only the new bullet is marked, the card says Add', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('blocks.md', DOC)
    await openEditor(page, { port: server.port, file: 'blocks.md' })
    await claude(server, 'blocks.md', [OPS.listAdd])
    await expect(page.locator('#mdr-editor-host .mdr-sugg--ins').first()).toBeVisible()
    expect(await marked(page)).toEqual({ del: [], ins: ['Delta item'] })
    await expect(page.locator(`[data-testid="${TESTID.suggestionItem}"] .mdr-suggestion-kind`).first()).toHaveText('Add')
  })

  test('Claude removes a bullet: only that bullet is struck', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('blocks.md', DOC)
    await openEditor(page, { port: server.port, file: 'blocks.md' })
    await claude(server, 'blocks.md', [{ op: 'suggest_block', target: { quote: 'Alpha item' }, markdown: '- Alpha item\n- Gamma item', reason: 'Drop Beta.' }])
    await expect(page.locator('#mdr-editor-host .mdr-sugg--del').first()).toBeVisible()
    expect(await marked(page)).toEqual({ del: ['Beta item'], ins: [] })
  })

  test('Claude adds a blockquote line: only the new line is marked', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('quote.md', 'Before.\n\n> Quote line one.\n\nAfter.\n')
    await openEditor(page, { port: server.port, file: 'quote.md' })
    await claude(server, 'quote.md', [{ op: 'suggest', quote: 'Quote line one.', replace: 'Quote line one.\n>\n> Quote line two.', reason: 'More.' }])
    await expect(page.locator('#mdr-editor-host .mdr-sugg--ins').first()).toBeVisible()
    expect(await marked(page)).toEqual({ del: [], ins: ['Quote line two.'] })
  })

  test("TJ's Enter + typing in Suggesting mode (a bullet, a blockquote line) looks the same after a reload", async ({ page, server }) => {
    const ed = await openEditor(page, { port: server.port, file: 'basic.md' })
    await ed.bridge((b) => b.setMode('suggesting'))
    await placeCaret(page, 'Publish the FAQ', 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Write the blog post')
    await placeCaret(page, 'A short quote for context.', 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Another quote line')
    await expect(page.locator('#mdr-editor-host .mdr-sugg--ins').filter({ hasText: 'Another quote line' }).first()).toBeVisible()
    const before = await marked(page)
    expect(before.del).toEqual([])
    await ed.session((s) => s.flush())
    await expect.poll(() => ed.session((s) => s.getReview().suggestions.filter((x) => x.by === 'TJ' && x.status === 'pending').length)).toBeGreaterThanOrEqual(2)
    // a fresh load re-places the stored records from scratch
    await openEditor(page, { port: server.port, file: 'basic.md' })
    await expect(page.locator('#mdr-editor-host .mdr-sugg--ins').first()).toBeVisible()
    const after = await marked(page)
    expect(after.del).toEqual([])
    expect(after.ins.join('|')).toContain('Write the blog post')
    expect(after.ins.join('|')).toContain('Another quote line')
    const kinds = await page.locator(`[data-testid="${TESTID.suggestionItem}"] .mdr-suggestion-kind`).allTextContents()
    expect(kinds.length).toBeGreaterThanOrEqual(2)
    expect(kinds.every((k) => k === 'Add')).toBe(true)
  })

  test('accepting writes the added bullet and nothing else; rejecting leaves the file as it was', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('blocks.md', DOC)
    const ed = await openEditor(page, { port: server.port, file: 'blocks.md' })
    const r = await claude(server, 'blocks.md', [OPS.listAdd, OPS.paraDel])
    const [add, del] = r.results.map((x) => x.suggestion!)
    await expect(page.locator(`#mdr-editor-host [data-suggestion="${add}"]`).first()).toBeAttached()
    await expect(page.locator(`#mdr-editor-host [data-suggestion="${del}"]`).first()).toBeAttached()
    expect(await ed.bridge((b, id) => b.accept(id), add!)).toMatchObject({ ok: true })
    await ed.session((s) => s.flush())
    await expect.poll(() => tmpRoot.read('blocks.md')).toBe(DOC.replace('- Gamma item\n', '- Gamma item\n- Delta item\n'))
    expect(await ed.bridge((b, id) => b.reject(id), del!)).toMatchObject({ ok: true })
    await ed.session((s) => s.flush())
    await expect(page.locator('#mdr-editor-host .mdr-sugg')).toHaveCount(0)
    expect(tmpRoot.read('blocks.md')).toBe(DOC.replace('- Gamma item\n', '- Gamma item\n- Delta item\n'))
  })
})
