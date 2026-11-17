// tests/e2e/int-concurrency.spec.ts (integrator, M4; CONTRACTS §2.5 "int-concurrency", §3.6, §7.3, §9.3, §12.4,
// §12.5, R1.5, R5.3, Appendix B row "Concurrent CLI write (server down) + autosave → no lost event").
//
// The p1-concurrency story with TJ in the real page. TJ types and it saves; the server goes down (SIGTERM, which
// leaves the marker, so the token survives the restart); TJ keeps typing (the save chip says Offline and his edit is
// kept as a draft); Claude writes through the CLI in direct mode while the server is down (an edit on another block,
// a comment and a suggestion, then a positional insert); the server comes back. Nothing is lost:
// - the CLI writes are adopted by hash (Claude's, never `external`);
// - the page reconnects on its own, its held autosave merges block-wise (TJ's block and Claude's blocks all reach the
//   disk), the chip ends on Saved, no conflict card, and the editor shows Claude's edit, comment card and inline
//   suggestion;
// - the sidecar is one contiguous seq run, attributed TJ / Claude / system only; `mdr pending` holds TJ's two edits
//   and no external change.
// The second case closes the tab while the server is down and opens it again after the restart: the edit typed while
// offline comes back from the draft store (the "Recovered unsaved edits" toast) and merges with Claude's direct write.
import type { BatchResult, PendingResult } from '../../shared/types'
import { cardOf, INT_PORT_OFFSET, liveMarkdown, pageSaveState, tid, toastOf } from '../helpers/int'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { placeCaret } from './fixtures/p2'
import { railSettled } from './fixtures/p3'
import { ok } from './fixtures/p4'

const FILE = 'basic.md'

test.use({ serverKind: 'real', fixtureFiles: [FILE], docFile: FILE, portOffset: INT_PORT_OFFSET })

type Line = { type?: string; by?: string; seq: number; rev?: number; cause?: string; changes?: Array<{ before?: { md?: string } | null; after?: { md?: string } | null }> | null }
const mdOfChanges = (l: Line): string => (l.changes ?? []).map((c) => `${c.before?.md ?? ''}\n${c.after?.md ?? ''}`).join('\n')

/** Claude, server down: one direct batch (edit, comment, suggestion), then a positional insert at the new rev. */
async function claudeDirect(cli: import('./fixtures').CliHelper): Promise<{ r1: BatchResult; r2: BatchResult }> {
  const b1 = await cli.batch(FILE, { ops: [
    { op: 'replace_block', target: { quote: 'The member rate is reviewed every quarter.' }, markdown: 'The member rate is reviewed every month.' },
    { op: 'comment', quote: 'Grow the waitlist', body: 'Is this still the first goal?' },
    { op: 'suggest', quote: 'Ship the explainer page', replace: 'Ship the explainer video', reason: 'video tested better' },
  ] })
  expect(b1.code, b1.stdout + b1.stderr).toBe(0)
  const r1 = b1.json as BatchResult
  expect(r1).toMatchObject({ ok: true, via: 'direct', noop: false })
  const b2 = await cli.batch(FILE, { ops: [{ op: 'insert_after', target: { ref: 'b1', rev: r1.rev }, markdown: '_Draft for review._' }] })
  expect(b2.code, b2.stdout + b2.stderr).toBe(0)
  const r2 = b2.json as BatchResult
  expect(r2).toMatchObject({ via: 'direct', rev: r1.rev + 1 })
  return { r1, r2 }
}

/** One contiguous seq run, every line attributed to TJ, Claude or system (never external), no doc.external. */
function assertLedger(lines: Line[]): void {
  const seqs = lines.filter((l) => typeof l.seq === 'number').map((l) => l.seq)
  expect(seqs.length).toBeGreaterThan(0)
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0]! + i))
  const authors = new Set(lines.map((l) => l.by).filter((b) => b !== undefined))
  for (const a of authors) expect(['TJ', 'Claude', 'system']).toContain(a)
  expect(lines.some((l) => l.type === 'doc.external'), 'direct-mode writes are adopted, never external').toBe(false)
}

test('TJ types, the server goes down, TJ keeps typing, Claude writes direct, the server returns: the page\'s autosave merges, nothing lost', async ({ page, server, cli, tmpRoot }) => {
  test.setTimeout(90_000)
  const abs = cli.abs(FILE)
  await page.setViewportSize({ width: 1440, height: 900 })
  const ed = await openEditor(page, { port: server.port, file: FILE })
  await railSettled(page)

  // TJ's first edit saves
  await placeCaret(page, 'paid monthly', 'end')
  await page.keyboard.type(' (net)')
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toContain('paid monthly (net). We launch in Q3.')
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'saved')
  const token = server.token

  // the server goes down; TJ keeps typing in another block: the save fails, the chip says Offline
  await server.stop()
  expect(tmpRoot.exists('.review/server.json'), 'a signal leaves the marker for the successor').toBe(true)
  await placeCaret(page, 'Final paragraph', 'start')
  await page.keyboard.type('Closing note. ')
  await expect.poll(() => pageSaveState(page), { timeout: 10_000 }).toBe('offline')
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'offline')
  expect(tmpRoot.read(FILE)).not.toContain('Closing note.')

  // Claude, server down: direct mode under the doc lock
  const { r1, r2 } = await claudeDirect(cli)
  const thread = r1.results[1]!.thread!
  const sug = r1.results[2]!.suggestion!
  expect(tmpRoot.read(FILE)).toContain('The member rate is reviewed every month.')

  // the server comes back with the same token; the page reconnects by itself and its held save merges
  await server.restart()
  expect(server.token).toBe(token)
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 20_000 }).toContain('Closing note. Final paragraph')
  await expect.poll(() => pageSaveState(page), { timeout: 10_000 }).toBe('saved')
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'saved')
  const disk = tmpRoot.read(FILE)
  // every writer's change is on disk: TJ's first edit, Claude's edit and insert, TJ's offline edit
  expect(disk).toContain('paid monthly (net). We launch in Q3.')
  expect(disk).toContain('The member rate is reviewed every month.')
  expect(disk).toContain('_Draft for review._')
  expect(disk).toContain('Closing note. Final paragraph with **bold**')
  expect(disk, 'a pending suggestion never reaches the .md').not.toContain('explainer video')
  await expect(page.locator(tid('conflictCard'))).toHaveCount(0)
  // the editor shows the merged text, Claude's comment card and his inline suggestion
  await expect.poll(() => liveMarkdown(page), { timeout: 10_000 }).toBe(disk)
  await expect(cardOf(page, thread)).toHaveCount(1)
  await expect(cardOf(page, thread).locator(tid('message', { 'data-by': 'Claude' }))).toContainText('Is this still the first goal?')
  await expect(ed.testid('highlight', { 'data-thread': thread })).toHaveText(['Grow the waitlist'])
  await expect(ed.testid('suggestion', { 'data-suggestion': sug, 'data-kind': 'ins' }).first()).toBeVisible()
  await expect(ed.testid('suggestion', { 'data-suggestion': sug, 'data-kind': 'ins' }).first()).toHaveAttribute('data-by', 'Claude')

  // the ledger: Claude's direct revs adopted as Claude's, TJ's offline save after them, one contiguous run
  const lines = tmpRoot.readSidecar(FILE) as Line[]
  assertLedger(lines)
  const revs = lines.filter((l) => l.type === 'doc.rev')
  expect(revs.find((l) => l.rev === r1.rev)).toMatchObject({ by: 'Claude' })
  expect(revs.find((l) => l.rev === r2.rev)).toMatchObject({ by: 'Claude' })
  expect(revs.filter((l) => (l.rev ?? 0) > r2.rev).map((l) => l.by)).toContain('TJ')
  for (const e of lines.filter((l) => l.type === 'doc.edit' && l.by === 'TJ')) {
    expect(mdOfChanges(e)).not.toContain('every month')
    expect(mdOfChanges(e)).not.toContain('_Draft for review._')
  }

  // what Claude reads next: TJ's two edits, nothing external
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(p.via).toBe('server')
  expect(p.external).toEqual([])
  expect(p.edits.every((e) => e.by === 'TJ')).toBe(true)
  const tjText = p.edits.flatMap((e) => e.blocks.map((b) => (b.change.format === 'full' ? b.change.after ?? '' : b.change.diff))).join('\n')
  expect(tjText).toContain('(net)')
  expect(tjText).toContain('Closing note.')
  expect(tjText).not.toContain('every month')
})

test('the tab is closed while the server is down and reopened after the restart: the offline edit comes back from the draft and merges with Claude\'s direct write', async ({ page, context, server, cli, tmpRoot }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const ed = await openEditor(page, { port: server.port, file: FILE })
  await railSettled(page)
  await expect(ed.testid('saveChip')).toHaveAttribute('data-state', 'saved')

  // server down; TJ types; his draft is kept in the browser's draft store; he closes the tab
  await server.stop()
  await placeCaret(page, 'A short quote for context.', 'end')
  await page.keyboard.type(' Typed offline.')
  await expect.poll(() => pageSaveState(page), { timeout: 10_000 }).toBe('offline')
  await page.waitForTimeout(800) // DRAFT_DEBOUNCE_MS (250 ms) plus the idle callback
  await page.close()

  // Claude writes direct; the server comes back
  const { r1 } = await claudeDirect(cli)
  await server.restart()

  // TJ opens the doc again: the draft is recovered and saved against current, merged with Claude's blocks
  const page2 = await context.newPage()
  await page2.setViewportSize({ width: 1440, height: 900 })
  const ed2 = await openEditor(page2, { port: server.port, file: FILE })
  await expect(toastOf(page2, 'DRAFT_RECOVERED')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => tmpRoot.read(FILE), { timeout: 15_000 }).toContain('> A short quote for context. Typed offline.')
  await expect.poll(() => pageSaveState(page2), { timeout: 10_000 }).toBe('saved')
  const disk = tmpRoot.read(FILE)
  expect(disk).toContain('The member rate is reviewed every month.')
  expect(disk).toContain('_Draft for review._')
  await expect(page2.locator(tid('conflictCard'))).toHaveCount(0)
  await expect.poll(() => liveMarkdown(page2), { timeout: 10_000 }).toBe(disk)
  await expect(cardOf(page2, r1.results[1]!.thread!)).toHaveCount(1)
  void ed2
  assertLedger(tmpRoot.readSidecar(FILE) as Line[])
  const p = ok<PendingResult>(await cli.run(['pending', cli.abs(FILE)]))
  expect(p.external).toEqual([])
  const tjText = p.edits.flatMap((e) => e.blocks.map((b) => (b.change.format === 'full' ? b.change.after ?? '' : b.change.diff))).join('\n')
  expect(tjText).toContain('Typed offline.')
})
