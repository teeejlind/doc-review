// tests/e2e/qa2-e-reload.spec.ts (QA round 2, agent E: unverified #7, #6, #4). Claude's disk write landing while TJ
// types or holds a selection must not touch his block or his caret (R4.4, R1.5), and the collapsed frontmatter panel
// and raw HTML blocks can't be node-selected and wiped by caret movement plus one key.
import { browserChoice } from '../helpers/browser'
import { claude, externalWrite, holdSaves, LINE_END, openDoc, placeCaret, saveState } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const DOC = '# Typing\n\nAlpha paragraph that Claude will edit.\n\nBravo paragraph that TJ is typing in.\n\nCharlie paragraph.\n'

test('qa2-e #7: keystrokes typed while TJ\'s save is in flight survive Claude\'s merged write (other block)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'type.md', content: DOC })
  const gate = await holdSaves(page)
  await page.getByText('Bravo paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' one two')
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
  // Claude rewrites a DIFFERENT block while TJ's save is on the wire, and TJ keeps typing
  await claude(server, 'type.md', [{ op: 'replace_block', target: { quote: 'Alpha paragraph' }, markdown: 'Alpha paragraph, rewritten by Claude.' }])
  await page.keyboard.type(' three four')
  await gate.release()
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toContain('rewritten by Claude.')
  // every character is in the editor, and typing goes on at the same caret
  await page.keyboard.type(' five')
  const want = '# Typing\n\nAlpha paragraph, rewritten by Claude.\n\nBravo paragraph that TJ is typing in. one two three four five\n\nCharlie paragraph.\n'
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toBe(want)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('type.md'), { timeout: 10_000 }).toBe(want)
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
  await expect.poll(() => saveState(ed)).toBe('saved')
})

test('qa2-e #7: the same through a plain disk write (Claude Code\'s Edit tool)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'type2.md', content: DOC })
  const gate = await holdSaves(page)
  await page.getByText('Bravo paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' one two')
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
  await externalWrite(server, tmpRoot, 'type2.md', DOC.replace('Alpha paragraph that Claude will edit.', 'Alpha paragraph, rewritten on disk.'))
  await page.keyboard.type(' three four')
  await gate.release()
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toContain('rewritten on disk.')
  await page.keyboard.type(' five')
  const want = '# Typing\n\nAlpha paragraph, rewritten on disk.\n\nBravo paragraph that TJ is typing in. one two three four five\n\nCharlie paragraph.\n'
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toBe(want)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('type2.md'), { timeout: 10_000 }).toBe(want)
  await expect.poll(() => saveState(ed)).toBe('saved')
})

test('qa2-e #7: a trailing space TJ just typed is not dropped when Claude\'s write merges (the markdown trims it)', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'type3.md', content: DOC })
  const gate = await holdSaves(page)
  await page.getByText('Bravo paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' one two ')
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
  await claude(server, 'type3.md', [{ op: 'replace_block', target: { quote: 'Alpha paragraph' }, markdown: 'Alpha paragraph, rewritten by Claude.' }])
  await gate.release()
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toContain('rewritten by Claude.')
  await page.keyboard.type('three')
  const want = '# Typing\n\nAlpha paragraph, rewritten by Claude.\n\nBravo paragraph that TJ is typing in. one two three\n\nCharlie paragraph.\n'
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toBe(want)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('type3.md'), { timeout: 10_000 }).toBe(want)
})

test('qa2-e #7: Enter and a new paragraph typed while the save is in flight survive Claude\'s merged write, caret included', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'enter.md', content: DOC })
  const gate = await holdSaves(page)
  await page.getByText('Bravo paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' one two')
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
  await claude(server, 'enter.md', [{ op: 'replace_block', target: { quote: 'Alpha paragraph' }, markdown: 'Alpha paragraph, rewritten by Claude.' }])
  await page.keyboard.press('Enter')
  await page.keyboard.type('New paragraph typed in flight')
  await gate.release()
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toContain('rewritten by Claude.')
  await page.keyboard.type(' and more')
  const want = '# Typing\n\nAlpha paragraph, rewritten by Claude.\n\nBravo paragraph that TJ is typing in. one two\n\nNew paragraph typed in flight and more\n\nCharlie paragraph.\n'
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toBe(want)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('enter.md'), { timeout: 10_000 }).toBe(want)
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
})

// unverified #6 does not reproduce as a reload bug: the stale caret came from a click delivered within a millisecond of the
// drag's mouseup, where ProseMirror's own deferred selection sync (MouseDown.done) writes the old range back over the click,
// with or without a Claude write. With any human spacing the caret survives the write; this pins that.
test('qa2-e #6 (pin): a drag-select, then a click elsewhere, then Claude\'s write: typing lands where TJ clicked', async ({ page, server, tmpRoot }) => {
  const LIST = '# Launch plan\n\n- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ\n\nFinal paragraph with bold and code.\n'
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'caret.md', content: LIST })
  const box = await page.evaluate(() => {
    const li = [...document.querySelectorAll('#mdr-editor-host .ProseMirror li')].find((x) => x.textContent?.includes('Ship the explainer'))!
    const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
    const t = w.nextNode() as Text
    const r = document.createRange()
    r.setStart(t, 0)
    r.setEnd(t, 'Ship the explainer'.length)
    const b = r.getBoundingClientRect()
    return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 }
  })
  await page.mouse.move(box.x1, box.y)
  await page.mouse.down()
  await page.mouse.move((box.x1 + box.x2) / 2, box.y, { steps: 4 })
  await page.mouse.move(box.x2, box.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  await page.getByText('Final paragraph').click()
  await claude(server, 'caret.md', [{ op: 'replace_block', target: { quote: 'Launch plan' }, markdown: '# Launch plan v2' }])
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toContain('# Launch plan v2')
  await page.waitForTimeout(500)
  await page.keyboard.type('TYPED')
  await expect.poll(() => ed.debug.liveMarkdown(), { timeout: 10_000 }).toMatch(/Final paragraph[^\n]*TYPED|TYPED[^\n]*bold/)
  const md = await ed.debug.liveMarkdown()
  expect(md).toContain('- Ship the explainer page\n')
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('caret.md')).toBe(md)
})
