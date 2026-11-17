// tests/e2e/p2-reload.spec.ts (P2; CONTRACTS §14 P2 e2e "p2-reload", §5.4, §7.3, §10, §12.6, §13 #8, #10, #64, #74,
// D47). Remote changes in real Chromium: an external disk edit (Claude's Edit tool) above the viewport while TJ types
// further down keeps his caret and the scroll position; Claude editing the adjacent block never conflicts, even when
// TJ's save lands after it (stale base, merged); a duplicate-quote highlight stays on its occurrence through a context
// edit and an external write; a restore through session().history.restore(v) shows the restored text before it
// resolves, and the next edit saves against it.
import { browserChoice } from '../helpers/browser'
import { claude, externalWrite, holdSaves, LINE_END, openDoc, placeCaret, saveState } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const para = (i: number): string =>
  `Paragraph ${i}: the notes carry a member rate that is reviewed every quarter, and this sentence is long enough to wrap onto a second line in the column.`
const LONG = ['# Long doc', '', ...Array.from({ length: 60 }, (_, i) => [para(i + 1), '']).flat()].join('\n')

/** px from the scroll container's top edge to the top of the editor block containing `text` (negative = above it). */
async function blockOffset(page: import('@playwright/test').Page, text: string): Promise<number> {
  return page.evaluate((t) => {
    const scroll = document.getElementById('mdr-scroll')!
    const pm = document.querySelector('#mdr-editor-host .ProseMirror')!
    const el = [...pm.children].find((c) => c.textContent?.includes(t))!
    return el.getBoundingClientRect().top - scroll.getBoundingClientRect().top
  }, text)
}

test('p2-reload: an external edit above the viewport while TJ types keeps his caret and the scroll position (§12.6, §13 #8)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: LONG })
  // scroll so paragraph 40 sits in the viewport, then type at its end with the real keyboard
  await page.evaluate(() => {
    const scroll = document.getElementById('mdr-scroll')!
    const pm = document.querySelector('#mdr-editor-host .ProseMirror')!
    const el = [...pm.children].find((c) => c.textContent?.startsWith('Paragraph 40:'))!
    scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 120
  })
  // (the caret is placed through the DOM: on macOS, Chrome's End key also smooth-scrolls the scroller to the bottom)
  await placeCaret(page, para(40), 'end')
  await page.keyboard.type(' TJ was here')
  const before = await blockOffset(page, 'Paragraph 40:')
  const scrollBefore = await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)

  // Claude's Edit tool rewrites paragraph 5 into three paragraphs, while TJ's typing may still be unsaved
  const disk = tmpRoot.read('long.md')
  const theirs = disk.replace(para(5), `${para(5)} Rewritten by Claude.\n\nInserted above A.\n\nInserted above B.`)
  expect(theirs).not.toBe(disk)
  // §12.6 budget, on the real watcher: under 1 s from the disk write to the repaint
  const t0 = Date.now()
  tmpRoot.write('long.md', theirs)
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000, intervals: [25] }).toContain('Inserted above B.')
  const repaintMs = Date.now() - t0
  test.info().annotations.push({ type: 'repaint-ms', description: String(repaintMs) })
  expect(repaintMs, 'disk write → repaint (§12.6)').toBeLessThan(1_000)

  // the viewport did not jump: paragraph 40 stays where TJ was looking (content above grew, scrollTop followed)
  await expect.poll(() => blockOffset(page, 'Paragraph 40:')).toBeGreaterThan(before - 2)
  expect(Math.abs((await blockOffset(page, 'Paragraph 40:')) - before)).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)).toBeGreaterThan(scrollBefore)
  // the caret is still right after TJ's text: more typing lands there
  await page.keyboard.type(' and kept typing')
  await expect.poll(() => tmpRoot.read('long.md'), { timeout: 10_000 }).toContain(`${para(40)} TJ was here and kept typing`)
  const final = tmpRoot.read('long.md')
  expect(final).toContain('Rewritten by Claude.\n\nInserted above A.\n\nInserted above B.')
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
  await expect.poll(() => saveState(ed)).toBe('saved')
})

test('p2-reload: Claude editing the block next to TJ\'s never conflicts, even when TJ\'s save lands after it (§7.3, §13 #10)', async ({ page, server, tmpRoot }) => {
  const DOC = '# Adjacent\n\nAlpha paragraph that Claude will edit.\n\nBravo paragraph that TJ is typing in.\n\nCharlie paragraph.\n'
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'adj.md', content: DOC })
  const gate = await holdSaves(page)
  await page.getByText('Bravo paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' TJ typed this.')
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
  // Claude replaces the block just above while TJ's save is still in flight; and the one just below
  await claude(server, 'adj.md', [
    { op: 'replace_block', target: { quote: 'Alpha paragraph' }, markdown: 'Alpha paragraph, rewritten by Claude.' },
    { op: 'replace_block', target: { quote: 'Charlie paragraph' }, markdown: 'Charlie paragraph, also Claude.' },
  ])
  await gate.release()
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('adj.md')).toBe(
    '# Adjacent\n\nAlpha paragraph, rewritten by Claude.\n\nBravo paragraph that TJ is typing in. TJ typed this.\n\nCharlie paragraph, also Claude.\n',
  )
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
  await expect.poll(() => saveState(ed)).toBe('saved')
  await expect(ed.testid('conflictBlock')).toHaveCount(0)
  await expect.poll(() => ed.debug.liveMarkdown()).toBe(tmpRoot.read('adj.md'))
})

test('p2-reload: a duplicate-quote highlight stays on its occurrence through a context edit and an external write (§5.4, §13 #74)', async ({ page, server, tmpRoot }) => {
  const DOC = '# Duplicate quotes\n\nThe member rate is fixed for the first deal.\n\nSome unrelated text sits between the two occurrences.\n\nFor the second deal the member rate is floating.\n'
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'dup.md', content: DOC })
  await placeCaret(page, 'member rate', 'select', 1)
  const target = await ed.bridge((b) => b.getSelectionTarget())
  expect(target?.kind).toBe('anchor')
  if (target?.kind !== 'anchor') throw new Error('expected a text anchor')
  const created = await ed.session((s, a) => s.createThread(a, 'Check the second one'), target.anchor)
  const thread = created.thread.id
  const hl = ed.testid('highlight', { 'data-thread': thread })
  await expect(hl.first()).toBeVisible()
  const hostParagraph = (): Promise<string> => hl.first().evaluate((el) => el.closest('p')?.textContent ?? '')
  expect(await hostParagraph()).toContain('second deal')

  // TJ edits the context around the second occurrence: the save refreshes the duplicate quote's context
  await placeCaret(page, 'For the second deal', 'start')
  await page.keyboard.type('Later, ')
  await expect.poll(() => tmpRoot.read('dup.md')).toContain('Later, For the second deal the member rate is floating.')
  await expect
    .poll(() => (tmpRoot.readSidecar('dup.md') as Array<{ type?: string; by?: string; thread?: string }>).some((e) => e.type === 'anchor.update' && e.by === 'TJ' && e.thread === thread))
    .toBe(true)

  // an external write puts a third "member rate" above both; the page reloads; the highlight stays on its occurrence
  const disk = tmpRoot.read('dup.md')
  await externalWrite(server, tmpRoot, 'dup.md', disk.replace('# Duplicate quotes\n', '# Duplicate quotes\n\nNote: the member rate differs by deal.\n'))
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('Note: the member rate differs by deal.')
  await expect(hl.first()).toBeVisible()
  await expect.poll(hostParagraph).toContain('Later, For the second deal')
  await expect(hl).toHaveCount(1)
  await expect.poll(() => ed.session((s, id) => s.getReview().threads.find((t) => t.id === id)?.detached, thread)).toBe(false)
})

test('p2-reload: restore through session().history.restore(v) shows the restored text before it resolves; the next edit saves against it (§10, §13 #64, D47)', async ({ page, server, tmpRoot }) => {
  const DOC = '# Restore me\n\nFirst paragraph as written.\n\nSecond paragraph as written.\n'
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'restore.md', content: DOC })
  await page.getByText('Second paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' Edited once.')
  await expect.poll(() => tmpRoot.read('restore.md')).toContain('as written. Edited once.')
  await ed.session((s) => s.flush())
  const versions = await ed.session(async (s) => (await s.history.list()).versions)
  expect(versions.length).toBeGreaterThan(0)
  const target = [...versions].sort((a, b) => a.n - b.n).find((v) => v.size === Buffer.byteLength(DOC))
  expect(target, `no version with the original bytes in ${JSON.stringify(versions)}`).toBeTruthy()
  const text = await ed.session(async (s, v) => (await s.history.show(v)).markdown, target!.v)
  expect(text).toBe(DOC)

  // the editor holds the restored text by the time restore() resolves (adopted through the reload path)
  const live = await ed.session(async (s, v) => {
    await s.history.restore(v)
    const d = (window as unknown as { __mdrDebug: { liveMarkdown(): string } }).__mdrDebug
    return d.liveMarkdown()
  }, target!.v)
  expect(live).toBe(DOC)
  expect(tmpRoot.read('restore.md')).toBe(DOC)
  expect(await ed.debug.planSave()).toEqual([])

  // the next keystroke edit saves against the restored text (no conflict, no resurrected "Edited once.")
  await page.getByText('First paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' After restore.')
  await expect.poll(() => tmpRoot.read('restore.md')).toBe(DOC.replace('First paragraph as written.', 'First paragraph as written. After restore.'))
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
  await expect.poll(() => saveState(ed)).toBe('saved')
})
