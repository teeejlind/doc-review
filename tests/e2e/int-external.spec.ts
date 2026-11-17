// tests/e2e/int-external.spec.ts (integrator, M4; CONTRACTS §2.5 "int-external", §3.6, §8.6, §12.6, R4.3, R4.4,
// Appendix B rows "TJ edits per block attributed TJ; Claude disk writes never TJ" and "Claude edit while open → reload
// < 1s, cursor/scroll kept").
//
// Claude rewrites the .md on disk (its Edit tool: a plain file write, no mdr involved) while TJ is typing in the full
// UI further down the page, with Claude's comments on the page above and below. Through the real watcher, server, SSE
// and P2's reload path under P3's shell:
// - the page repaints Claude's change in < 1 s, the block TJ is looking at stays where it was (scroll anchored), and
//   his caret stays put: more typing lands right after his earlier text;
// - both comment highlights stay on their own text and their cards stay on the rail; nothing conflicts and the save
//   chip ends on Saved;
// - attribution: the disk change is `external` everywhere (doc-changed on the browser channel, the doc.rev and
//   doc.external lines, the history version, `mdr pending`'s `external`); TJ's typing is `TJ` everywhere, and no TJ
//   doc.edit or pending TJ edit ever contains Claude's text.
// A second case puts the external write inside the very paragraph TJ is typing in, with his keystrokes unsaved (a
// held save): the block-level 3-way merge either keeps both or raises the conflict card, and never attributes the
// disk text to TJ.
import type { HistoryList, PendingResult } from '../../shared/types'
import { blockOffset, cardOf, INT_PORT_OFFSET, liveMarkdown, pageSaveState, scrollBlockTo, tid } from '../helpers/int'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { holdSaves, placeCaret } from './fixtures/p2'
import { railSettled } from './fixtures/p3'
import { ok, recordEvents, sleep } from './fixtures/p4'

const FILE = 'long.md'

test.use({ serverKind: 'real', fixtureFiles: [], docFile: FILE, portOffset: INT_PORT_OFFSET })

const para = (i: number): string =>
  `Paragraph ${i}: the notes carry a member rate that is reviewed every quarter, and marker${i}x makes this sentence long enough to wrap onto a second line in the column.`
const LONG = ['# Long doc', '', ...Array.from({ length: 60 }, (_, i) => [para(i + 1), '']).flat()].join('\n')

type Line = { type?: string; by?: string; rev?: number; cause?: string; seq: number; changes?: Array<{ before?: { md?: string } | null; after?: { md?: string } | null }> | null }
const mdOfChanges = (l: Line): string => (l.changes ?? []).map((c) => `${c.before?.md ?? ''}\n${c.after?.md ?? ''}`).join('\n')
const pendingText = (e: PendingResult['edits'][number]): string =>
  e.blocks.map((b) => (b.change.format === 'full' ? `${b.change.before ?? ''}\n${b.change.after ?? ''}` : b.change.diff)).join('\n')

test('Claude\'s disk edit above the viewport while TJ types: repaint < 1 s, scroll and caret kept, highlights follow, attributed external', async ({ page, server, cli, tmpRoot, webClient }) => {
  test.setTimeout(90_000)
  tmpRoot.write(FILE, LONG)
  const abs = cli.abs(FILE)
  // Claude's comments, one above the edit and one below TJ's caret
  const seed = await cli.batch(FILE, { ops: [
    { op: 'comment', quote: 'marker3x', body: 'Above the rewrite.' },
    { op: 'comment', quote: 'marker42x', body: 'Below TJ\'s caret.' },
  ] })
  expect(seed.code, seed.stdout + seed.stderr).toBe(0)
  const [above, below] = (seed.json as { results: Array<{ thread: string }> }).results.map((r) => r.thread)

  await page.setViewportSize({ width: 1440, height: 900 })
  const ed = await openEditor(page, { port: server.port, file: FILE })
  await railSettled(page)
  await expect(cardOf(page, above!)).toHaveCount(1)
  await expect(cardOf(page, below!)).toHaveCount(1)

  // TJ scrolls so paragraph 40 sits near the top, and types at its end with the real keyboard
  await scrollBlockTo(page, 'Paragraph 40:', 120)
  await placeCaret(page, para(40), 'end')
  await page.keyboard.type(' TJ was here')
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toContain(`${para(40)} TJ was here`)
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'saved')
  const before = await blockOffset(page, 'Paragraph 40:')
  const scrollBefore = await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)
  const log = await recordEvents(webClient)
  await sleep(300) // the watcher is listening (chokidar's add is asynchronous)

  // TJ keeps typing; while his last keystrokes may still be unsaved, Claude's Edit tool rewrites paragraph 5 into three
  await page.keyboard.type(' again')
  const disk = tmpRoot.read(FILE)
  const theirs = disk.replace(para(5), `${para(5)} Rewritten by Claude.\n\nInserted above A.\n\nInserted above B.`)
  expect(theirs).not.toBe(disk)
  const from = log.mark()
  const t0 = Date.now()
  tmpRoot.write(FILE, theirs)
  await expect.poll(() => liveMarkdown(page), { timeout: 10_000, intervals: [25] }).toContain('Inserted above B.')
  const repaintMs = Date.now() - t0
  test.info().annotations.push({ type: 'repaint-ms', description: String(repaintMs) })
  expect(repaintMs, 'disk write → repaint in the full UI (§12.6)').toBeLessThan(1_000)

  // the browser channel names the writer: external, never TJ, never stamped with a clientId
  const dc = await log.next('doc-changed', { from, where: (e) => e.data.by === 'external', timeoutMs: 3_000 })
  expect(dc.data).toMatchObject({ file: FILE, by: 'external', cause: 'external' })
  expect(dc.data).not.toHaveProperty('clientId')

  // the viewport did not jump: paragraph 40 stays where TJ was looking (content above grew, scrollTop followed)
  await expect.poll(() => blockOffset(page, 'Paragraph 40:')).toBeGreaterThan(before - 2)
  expect(Math.abs((await blockOffset(page, 'Paragraph 40:')) - before)).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)).toBeGreaterThan(scrollBefore)

  // the caret is still right after TJ's text: more typing lands there
  await page.keyboard.type(' and kept typing')
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toContain(`${para(40)} TJ was here again and kept typing`)
  const final = tmpRoot.read(FILE)
  expect(final).toContain(`${para(5)} Rewritten by Claude.\n\nInserted above A.\n\nInserted above B.`)
  await expect.poll(() => pageSaveState(page)).toBe('saved')
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'saved')
  await expect(page.locator(tid('conflictCard'))).toHaveCount(0)
  await expect.poll(() => liveMarkdown(page)).toBe(final)

  // both highlights stay on their own text; their cards stay on the rail, nothing detached
  for (const [t, marker] of [[above!, 'marker3x'], [below!, 'marker42x']] as const) {
    await expect(ed.testid('highlight', { 'data-thread': t })).toHaveText([marker])
    await expect(cardOf(page, t)).toHaveCount(1)
  }
  await expect(page.locator(tid('detachedSection')).locator(tid('card'))).toHaveCount(0)
  const review = await webClient.review()
  expect(review.threads.filter((t) => t.detached).map((t) => t.id)).toEqual([])

  // attribution in the ledger: the external rev and doc.external are external's; TJ's edits never hold Claude's text
  await sleep(200)
  const lines = tmpRoot.readSidecar(FILE) as Line[]
  const extRev = lines.find((l) => l.type === 'doc.rev' && l.rev === dc.data.rev)
  expect(extRev).toMatchObject({ by: 'external', cause: 'external' })
  const ext = lines.filter((l) => l.type === 'doc.external')
  expect(ext).toHaveLength(1)
  expect(ext[0]!.by).toBe('external')
  expect(mdOfChanges(ext[0]!)).toContain('Inserted above A.')
  expect(mdOfChanges(ext[0]!)).not.toContain('TJ was here')
  const tjEdits = lines.filter((l) => l.type === 'doc.edit' && l.by === 'TJ')
  expect(tjEdits.length).toBeGreaterThan(0)
  for (const e of tjEdits) {
    expect(mdOfChanges(e)).toContain('TJ was here')
    expect(mdOfChanges(e)).not.toContain('Rewritten by Claude')
    expect(mdOfChanges(e)).not.toContain('Inserted above')
  }
  expect(lines.filter((l) => l.type === 'doc.rev' && l.by === 'TJ').every((l) => l.cause !== 'external')).toBe(true)

  // the same split in what Claude reads: `mdr pending` keeps external and TJ apart
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(p.external.length).toBeGreaterThan(0)
  for (const e of p.external) expect(e.by).toBe('external')
  expect(p.external.map(pendingText).join('\n')).toContain('Inserted above A.')
  expect(p.external.map(pendingText).join('\n')).not.toContain('TJ was here')
  expect(p.edits.length).toBeGreaterThan(0)
  for (const e of p.edits) {
    expect(e.by).toBe('TJ')
    expect(pendingText(e)).not.toContain('Rewritten by Claude')
  }
  expect(p.edits.map(pendingText).join('\n')).toContain('TJ was here again and kept typing')
  // counts are changed blocks after netting (§9.6): one paragraph rewritten into three counts 3
  expect(p.counts.external).toBe(3)
  expect(p.counts.edits).toBeGreaterThanOrEqual(1)

  // and history keeps the external change as an external version
  const hist = ok<HistoryList>(await cli.run(['history', abs]))
  expect(hist.versions.find((v) => v.rev === dc.data.rev)).toMatchObject({ by: 'external', cause: 'external' })
  await log.close()
})

test('Claude\'s disk edit inside the paragraph TJ is typing in, his save held: merged or a conflict card, never TJ\'s', async ({ page, server, cli, tmpRoot, webClient }) => {
  test.setTimeout(60_000)
  const DOC = '# Same block\n\nAlpha paragraph stays as it is.\n\nBravo paragraph that both of them change.\n\nCharlie paragraph.\n'
  tmpRoot.write(FILE, DOC)
  await page.setViewportSize({ width: 1440, height: 900 })
  const ed = await openEditor(page, { port: server.port, file: FILE })
  await railSettled(page)
  const gate = await holdSaves(page)
  await placeCaret(page, 'Bravo paragraph that both of them change.', 'end')
  await page.keyboard.type(' TJ typed this.')
  await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)

  // Claude's Edit tool rewrites the start of the same paragraph while TJ's save is in flight
  const theirs = DOC.replace('Bravo paragraph that', 'Bravo paragraph (rewritten by Claude) that')
  tmpRoot.write(FILE, theirs)
  await expect.poll(async () => (await webClient.doc()).markdown, { timeout: 5_000 }).toBe(theirs)
  await gate.release()
  await ed.session((s) => s.flush()).catch(() => undefined)

  // same block on both sides: the page surfaces it as a conflict (card on the rail, decoration on the block); the disk
  // keeps Claude's text until TJ chooses
  await expect(page.locator(tid('conflictCard'))).toHaveCount(1, { timeout: 10_000 })
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'conflict')
  expect(tmpRoot.read(FILE)).toBe(theirs)
  // TJ keeps his version: his text is written; Claude's disk text is never re-labelled as TJ's
  await page.locator(tid('conflictCard')).locator(tid('cardAction', { 'data-action': 'keep-mine' })).click()
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toContain('TJ typed this.')
  await expect(page.locator(tid('conflictCard'))).toHaveCount(0)
  await expect.poll(() => pageSaveState(page)).toBe('saved')
  const lines = tmpRoot.readSidecar(FILE) as Line[]
  const ext = lines.filter((l) => l.type === 'doc.external')
  expect(ext.map((l) => l.by)).toEqual(['external'])
  expect(mdOfChanges(ext[0]!)).toContain('rewritten by Claude')
  expect(lines.filter((l) => l.type === 'doc.rev' && l.cause === 'external').map((l) => l.by)).toEqual(['external'])
  const p = ok<PendingResult>(await cli.run(['pending', cli.abs(FILE)]))
  expect(p.external.map((e) => e.by)).toEqual(['external'])
  for (const e of p.edits) expect(e.by).toBe('TJ')
})
