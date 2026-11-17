// tests/e2e/qa2-b-editing.spec.ts (QA fix pass 2, agent B: CONFIRMED 14, 27, 30, 32).
//
// 14: redo of an undone Suggesting-mode edit brings back a real suggestion (new card, new sidecar event, visible in
//     `pending`), not a ghost mark that only the page shows.
// 27: Enter right after a word leaves no `&#x20;` in the .md.
// 30: an empty list item / quote line saves as a bare marker, no `<br />`.
// 32: what is on screen after Enter on an empty paragraph equals what is saved.
import type { PendingResult } from '../../shared/types'
import { TESTID } from '../../shared/constants'
import { expect, test } from './fixtures'
import { MOD, placeCaret, toEditing } from './fixtures/p2'
import { ok } from './fixtures/p4'

test.use({ serverKind: 'real', fixtureFiles: ['basic.md'], docFile: 'basic.md', viewport: { width: 1440, height: 900 } })

test('qa2-b 14: redo after undo of a Suggesting-mode edit is a real suggestion (card, sidecar, pending), and survives a reload', async ({ page, editorPage: ed, cli, tmpRoot }) => {
  test.setTimeout(90_000)
  const abs = cli.abs('basic.md')
  await ed.bridge((b) => b.setMode('suggesting'))
  await placeCaret(page, 'We launch in Q3', 'end')
  await page.keyboard.type(' 2026')
  const cards = page.locator(`[data-testid="${TESTID.card}"]`)
  const ins = () => page.evaluate(() => Array.from(document.querySelectorAll('.mdr-sugg--ins')).map((e) => e.textContent ?? ''))
  const pendingThreads = () => cli.run(['pending', abs]).then((r) => ok<PendingResult>(r).threads.length)
  // typed → saved → a card, and Claude sees it
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(1)
  await expect.poll(pendingThreads, { timeout: 15_000 }).toBe(1)

  // undo: the mark and the card go, the suggestion is withdrawn
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(ins).toEqual([])
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(0)
  await expect.poll(pendingThreads, { timeout: 15_000 }).toBe(0)

  // redo: the text is back as a suggestion Claude can see
  await page.keyboard.press(`${MOD}+Shift+z`)
  await expect.poll(ins).toEqual([' 2026'])
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(1)
  await expect.poll(pendingThreads, { timeout: 15_000 }).toBe(1)
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(JSON.stringify(p.threads)).toContain('2026')
  expect((await ed.session((s) => s.getSaveState().state))).toBe('saved')

  // reload: still there (it was real)
  await ed.session((s) => s.flush())
  await page.reload()
  await expect(ed.editor()).toBeVisible()
  await expect.poll(ins).toEqual([' 2026'])
  expect(tmpRoot.read('basic.md')).not.toContain('2026')
})

test('qa2-b 14b: undo, redo, undo, redo keeps working (each redo mints a new suggestion)', async ({ page, editorPage: ed, cli }) => {
  test.setTimeout(90_000)
  const abs = cli.abs('basic.md')
  await ed.bridge((b) => b.setMode('suggesting'))
  await placeCaret(page, 'We launch in Q3', 'end')
  await page.keyboard.type(' 2026')
  const cards = page.locator(`[data-testid="${TESTID.card}"]`)
  const pendingThreads = () => cli.run(['pending', abs]).then((r) => ok<PendingResult>(r).threads.length)
  await expect.poll(pendingThreads, { timeout: 15_000 }).toBe(1)
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(0)
    await expect.poll(pendingThreads, { timeout: 15_000 }).toBe(0)
    await page.keyboard.press(`${MOD}+Shift+z`)
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(pendingThreads, { timeout: 15_000 }).toBe(1)
  }
})

test('qa2-b 14c: undo and redo in quick succession keep the same suggestion (nothing was withdrawn)', async ({ page, editorPage: ed, cli }) => {
  test.setTimeout(60_000)
  const abs = cli.abs('basic.md')
  await ed.bridge((b) => b.setMode('suggesting'))
  await placeCaret(page, 'We launch in Q3', 'end')
  await page.keyboard.type(' 2026')
  const threads = async () => ok<PendingResult>(await cli.run(['pending', abs])).threads.map((t) => t.id)
  await expect.poll(async () => (await threads()).length, { timeout: 15_000 }).toBe(1)
  const [first] = await threads()
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press(`${MOD}+Shift+z`)
  await ed.session((s) => s.flush())
  await page.waitForTimeout(1500)
  expect(await threads()).toEqual([first])
  await expect(page.locator(`[data-testid="${TESTID.card}"]`)).toHaveCount(1)
})

test('qa2-b 27: Enter right after a word saves a clean split, no &#x20; in the file', async ({ page, editorPage: ed, tmpRoot }) => {
  await placeCaret(page, 'The notes carry a member', 'end') // between "member" and the space
  await page.keyboard.press('Enter')
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('The notes carry a member\n\nrate of 12% paid monthly.')
  expect(tmpRoot.read('basic.md')).not.toContain('&#x20;')
  // one undo puts the paragraph back whole
  await page.keyboard.press(`${MOD}+z`)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('The notes carry a member rate of 12% paid monthly.')
})

test('qa2-b 27: the same split in Suggesting mode proposes a clean split', async ({ page, editorPage: ed, tmpRoot }) => {
  await ed.bridge((b) => b.setMode('suggesting'))
  await placeCaret(page, 'The notes carry a member', 'end')
  await page.keyboard.press('Enter')
  await expect.poll(() => ed.session((s) => s.getReview().suggestions.length), { timeout: 15_000 }).toBe(1)
  const proposed = await ed.session((s) => s.getReview().suggestions[0]!.proposed)
  expect(proposed).not.toContain('&#x20;')
  expect(proposed).toContain('The notes carry a member\n\nrate of 12% paid monthly.')
  await ed.session((s) => s.flush())
  expect(tmpRoot.read('basic.md')).not.toContain('&#x20;')
})

test('qa2-b 30: Enter at the end of a list item and a pause writes a bare "-", no <br /> in the file', async ({ page, editorPage: ed, tmpRoot }) => {
  await placeCaret(page, 'Publish the FAQ', 'end')
  await page.keyboard.press('Enter')
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('- Publish the FAQ\n-\n')
  expect(tmpRoot.read('basic.md')).not.toContain('<br')
  // the empty item survives a reload as an empty bullet, and the list is still the editable kind
  await page.reload()
  await expect(ed.editor()).toBeVisible()
  // the test hooks arrive when createEditor resolves, a beat after the document shows (openEditor waits the same way)
  await page.waitForFunction(() => typeof (window as unknown as { __mdrDebug?: unknown }).__mdrDebug === 'object')
  await expect(page.locator('#mdr-editor-host .ProseMirror li')).toHaveCount(4)
  await expect(page.locator('#mdr-editor-host .ProseMirror [data-raw-block]')).toHaveCount(0)
  // a reload opens in Suggesting: back to Editing, as the spec was written
  await toEditing(page)
  // typing fills it
  await placeCaret(page, 'Publish the FAQ', 'end')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('Announce it')
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('- Publish the FAQ\n- Announce it\n')
})

test('qa2-b 32: Enter on an empty line adds no blank paragraph that would vanish on reload', async ({ page, editorPage: ed, tmpRoot }) => {
  const blocks = () => page.locator('#mdr-editor-host .ProseMirror > p').count()
  await placeCaret(page, 'Final paragraph with', 'end')
  await page.keyboard.press('Meta+ArrowRight')
  const before = await blocks()
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('After')
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('`code`.\n\nAfter')
  const onScreen = await blocks()
  expect(onScreen).toBe(before + 1)
  await page.reload()
  await expect(ed.editor()).toBeVisible()
  expect(await blocks()).toBe(onScreen)
})

test('qa2-b 14d: redo of a tracked paragraph split (node marks) is a real suggestion too', async ({ page, editorPage: ed, cli }) => {
  test.setTimeout(60_000)
  const abs = cli.abs('basic.md')
  await ed.bridge((b) => b.setMode('suggesting'))
  await placeCaret(page, 'Final paragraph with', 'end')
  await page.keyboard.press('Meta+ArrowRight')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Added line')
  const cards = page.locator(`[data-testid="${TESTID.card}"]`)
  const threads = async () => ok<PendingResult>(await cli.run(['pending', abs])).threads.length
  await expect.poll(threads, { timeout: 15_000 }).toBe(1)
  await page.keyboard.press(`${MOD}+z`)
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(threads, { timeout: 15_000 }).toBe(0)
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(0)
  await page.keyboard.press(`${MOD}+Shift+z`)
  await page.keyboard.press(`${MOD}+Shift+z`)
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(1)
  await expect.poll(threads, { timeout: 15_000 }).toBe(1)
})
