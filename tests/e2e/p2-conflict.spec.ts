// tests/e2e/p2-conflict.spec.ts (P2; CONTRACTS §14 P2 e2e "p2-conflict", §7.3, §7.4, §12.0.4, §12.4, §13 #9, #83, D37,
// D51). The save is held at the network (page.route) so "TJ typed" → "the disk changed" → "TJ's save lands" happens
// in that order every run. Same-block conflict: disk keeps theirs while held, the editor keeps TJ's text, the rest of
// the doc saves; resolveConflict mine / theirs through the bridge (the card is P3's). A Keep-mine save that meets a
// second write is refused whole (409) → recovered draft → keepRecoveredDraft. An unsaveable op forced with failSplice
// in the page and POST /__test/splice-fault on the server is held, the rest saves, and 'theirs' discards it.
import type { BlockConflict } from '../../shared/types'
import { browserChoice } from '../helpers/browser'
import { externalWrite, holdSaves, placeCaret, saveState, serverSpliceFault } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: ['basic.md'] })
test.skip(!BROWSER.available, BROWSER.reason)

type EP = import('../helpers/openEditor').EditorPage
type TR = import('../helpers/tmpRoot').TmpRoot
type SV = import('./fixtures').ServerUnderTest

/**
 * TJ types " Mine." at the end of the first paragraph and " Elsewhere." in the blockquote; before his save lands the
 * disk changes the first paragraph to Q4. Returns once the merged save is back and the conflict is registered.
 */
async function makeConflict(ed: EP, server: SV, tmpRoot: TR): Promise<BlockConflict> {
  const page = ed.page
  const gate = await holdSaves(page)
  await placeCaret(page, 'We launch in Q3.', 'end')
  await page.keyboard.type(' Mine.')
  await placeCaret(page, 'A short quote for context.', 'end')
  await page.keyboard.type(' Elsewhere.')
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
  await externalWrite(server, tmpRoot, 'basic.md', tmpRoot.read('basic.md').replace('We launch in Q3.', 'We launch in Q4.'))
  await gate.release()
  await expect.poll(() => ed.session((s) => s.getConflicts().length), { timeout: 10_000 }).toBe(1)
  await ed.session((s) => s.flush()).catch(() => undefined)
  const [c] = await ed.session((s) => s.getConflicts())
  return c!
}

test('p2-conflict: same-block conflict holds theirs on disk, keeps TJ\'s text, saves the rest; Keep mine writes mine (§7.4, §13 #9)', async ({ editorPage: ed, server, tmpRoot }) => {
  const c = await makeConflict(ed, server, tmpRoot)
  expect(c).toMatchObject({ kind: 'conflict' })
  expect(c.id.startsWith('conflict:')).toBe(true)
  expect(c.base).toContain('We launch in Q3.')
  expect(c.mine).toContain('We launch in Q3. Mine.')
  expect(c.theirs).toContain('We launch in Q4.')
  // disk keeps theirs while held; the non-conflicting block saved; the editor shows TJ's text with the decoration
  const disk = tmpRoot.read('basic.md')
  expect(disk).toContain('We launch in Q4.')
  expect(disk).not.toContain('Mine.')
  expect(disk).toContain('> A short quote for context. Elsewhere.')
  await expect.poll(() => ed.session((s) => s.getSaveState())).toEqual({ state: 'conflict', count: 1 })
  expect(await ed.debug.liveMarkdown()).toContain('We launch in Q3. Mine.')
  await expect(ed.testid('conflictBlock', { 'data-conflict': c.id })).toBeVisible()
  await expect(ed.testid('conflictBlock', { 'data-conflict': c.id })).toHaveAttribute('data-kind', 'conflict')
  // more typing elsewhere still saves while the conflict is open
  await placeCaret(ed.page, 'Publish the FAQ', 'end')
  await ed.page.keyboard.type(' now')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('- Publish the FAQ now')
  expect(tmpRoot.read('basic.md')).toContain('We launch in Q4.')

  await ed.bridge((b, id) => b.resolveConflict(id, 'mine'), c.id)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Mine.')
  expect(tmpRoot.read('basic.md')).not.toContain('Q4')
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
  await expect.poll(() => saveState(ed)).toBe('saved')
  await expect(ed.testid('conflictBlock')).toHaveCount(0)
  expect(await ed.debug.planSave()).toEqual([])
})

test('p2-conflict: Take theirs replaces the block in the editor and releases the hold (§7.4)', async ({ editorPage: ed, server, tmpRoot }) => {
  const c = await makeConflict(ed, server, tmpRoot)
  const before = tmpRoot.read('basic.md')
  await ed.bridge((b, id) => b.resolveConflict(id, 'theirs'), c.id)
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('We launch in Q4.')
  expect(await ed.debug.liveMarkdown()).not.toContain('Mine.')
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
  await ed.session((s) => s.flush())
  expect(tmpRoot.read('basic.md')).toBe(before)
  await expect.poll(() => saveState(ed)).toBe('saved')
  await expect(ed.testid('conflictBlock')).toHaveCount(0)
  expect(await ed.debug.planSave()).toEqual([])
  // Take theirs is an undoable edit like any other (addToHistory: true): undo brings TJ's text back, and it saves
  await ed.bridge((b) => b.focusEditor())
  await ed.page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+KeyZ`)
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('We launch in Q3. Mine.')
})

test('p2-conflict: a Keep-mine save that meets a second write is refused whole → recovered draft → keepRecoveredDraft (§12.4)', async ({ editorPage: ed, server, tmpRoot }) => {
  const c = await makeConflict(ed, server, tmpRoot)
  // Keep mine sends a strict save (cause merge, allowPartial false); hold it while the disk changes the block again
  const gate = await holdSaves(ed.page)
  await ed.bridge((b, id) => {
    void b.resolveConflict(id, 'mine')
  }, c.id)
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
  await externalWrite(server, tmpRoot, 'basic.md', tmpRoot.read('basic.md').replace('We launch in Q4.', 'We launch in Q5.'))
  await gate.release()
  await expect.poll(() => ed.session((s) => s.getRecoveredDraft()?.reason ?? null), { timeout: 10_000 }).toBe('merge-failed')
  const draft = await ed.session((s) => s.getRecoveredDraft())
  expect(draft!.markdown).toContain('We launch in Q3. Mine.')
  // nothing was written; the editor shows the current text
  expect(tmpRoot.read('basic.md')).toContain('We launch in Q5.')
  expect(tmpRoot.read('basic.md')).not.toContain('Mine.')
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('We launch in Q5.')

  await ed.session((s) => s.keepRecoveredDraft())
  await ed.session((s) => s.flush())
  expect(await ed.session((s) => s.getRecoveredDraft())).toBeNull()
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Mine.')
  expect(tmpRoot.read('basic.md')).toContain('> A short quote for context. Elsewhere.')
  expect(await ed.debug.liveMarkdown()).toBe(tmpRoot.read('basic.md'))
  expect(await ed.session((s) => s.getConflicts())).toEqual([])
  await expect.poll(() => saveState(ed)).toBe('saved')
})

test('p2-conflict: an unsaveable op (failSplice + /__test/splice-fault) is held, the rest saves, Discard restores disk (§13 #83, D37)', async ({ editorPage: ed, server, tmpRoot }) => {
  const original = tmpRoot.read('basic.md')
  const blocks = await ed.debug.blocks()
  const h = blocks.find((b) => original.slice(b.start, b.end).includes('reviewed every quarter'))!.hash
  try {
    await ed.debug.failSplice([h])
    await serverSpliceFault(server, 'basic.md', [h])
    await placeCaret(ed.page, 'reviewed every quarter.', 'end')
    await ed.page.keyboard.type(' Held back.')
    await placeCaret(ed.page, 'We launch in Q3.', 'end')
    await ed.page.keyboard.type(' Saved anyway.')
    await ed.session((s) => s.flush()).catch(() => undefined)
    await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Saved anyway.')
    const disk = tmpRoot.read('basic.md')
    expect(disk).toContain('The member rate is reviewed every quarter.\n')
    expect(disk).not.toContain('Held back.')
    const conflicts = await ed.session((s) => s.getConflicts())
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ kind: 'unsaveable', id: `unsaveable:${h}` })
    expect(conflicts[0]!.mine).toContain('Held back.')
    await expect.poll(() => ed.session((s) => s.getSaveState())).toEqual({ state: 'conflict', count: 1 })
    await expect(ed.testid('conflictBlock', { 'data-conflict': `unsaveable:${h}` })).toHaveAttribute('data-kind', 'unsaveable')
    // the rest of the doc keeps saving
    await placeCaret(ed.page, 'Grow the waitlist', 'end')
    await ed.page.keyboard.type(' fast')
    await expect.poll(() => tmpRoot.read('basic.md')).toContain('- Grow the waitlist fast')
    expect(tmpRoot.read('basic.md')).not.toContain('Held back.')

    // Discard my change: the block goes back to the disk text; nothing is held
    await ed.bridge((b, id) => b.resolveConflict(id, 'theirs'), `unsaveable:${h}` as const)
    await expect.poll(() => ed.debug.liveMarkdown()).not.toContain('Held back.')
    expect(await ed.session((s) => s.getConflicts())).toEqual([])
    await ed.session((s) => s.flush())
    await expect.poll(() => saveState(ed)).toBe('saved')
    expect(await ed.debug.liveMarkdown()).toBe(tmpRoot.read('basic.md'))
    expect(await ed.debug.planSave()).toEqual([])
  } finally {
    await ed.debug.failSplice([]).catch(() => undefined)
    await serverSpliceFault(server, 'basic.md', [])
  }
})
