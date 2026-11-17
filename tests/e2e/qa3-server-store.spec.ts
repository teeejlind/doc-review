// tests/e2e/qa3-server-store.spec.ts (QA round 3, fixer server-store, round 1).
//
// Typing and then reloading inside the autosave window restores the unsaved draft by swapping the whole editor doc.
// That used to collapse every comment highlight; the draft save then reported all of them as deleted and the server
// detached every thread, permanently, text nobody touched included (p3-r1-open-items g4/g5/g7).
import type { BatchResult, PendingResult, StatusResult, ThreadDetail } from '../../shared/types'
import { ok } from './fixtures/p4'
import { claude, placeCaret, summaries, toEditing } from './fixtures/p2'
import { TESTID } from '../../shared/constants'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1280, height: 900 } })

const paras = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} discusses the covenant package and the monthly reporting cadence for item ${i + 1}.`)
const DOC = '# Sheet test\n\n' + paras.join('\n\n') + '\n'

for (const waitMs of [0, 300]) {
  test(`qa3: typing then reloading after ${waitMs} ms keeps every comment attached (draft recovery)`, async ({ page, server, tmpRoot, cli }) => {
    const file = `reload-${waitMs}.md`
    tmpRoot.write(file, DOC)
    await claude(server, file, [3, 9, 15].map((n) => ({ op: 'comment' as const, quote: `Paragraph ${n} discusses`, body: `Claude note on ${n}` })))
    const url = `${server.origin}/?file=${encodeURIComponent(file)}`
    await page.goto(url)
    await page.waitForSelector(`[data-testid="${TESTID.editor}"]`)
    const highlights = page.locator(`[data-testid="${TESTID.highlight}"]`)
    await expect(highlights).toHaveCount(3)
    await toEditing(page)

    await placeCaret(page, 'Paragraph 2 discusses', 'start')
    await page.keyboard.type('ZZ ', { delay: 4 })
    await page.waitForTimeout(waitMs)
    await page.reload()
    await page.waitForSelector(`[data-testid="${TESTID.editor}"]`)

    // however the unsaved edit came back (a recovered draft or the unload flush), nobody's comment was deleted
    await expect(highlights).toHaveCount(3)
    await expect.poll(() => tmpRoot.read(file), { timeout: 10_000 }).toContain('ZZ Paragraph 2 discusses')
    await page.waitForTimeout(2_500)
    const st = ok<StatusResult>(await cli.run(['status', cli.abs(file)]))
    expect(st.threads).toEqual({ open: 3, resolved: 0, detached: 0 })
    await expect(highlights).toHaveCount(3)
    await expect(page.locator(`[data-testid="${TESTID.detachedSection}"]`)).toHaveCount(0)
  })
}

test('qa3: closing the tab (beforeunload) and opening a fresh one keeps every comment attached', async ({ page, server, tmpRoot, cli }) => {
  const file = 'close-reopen.md'
  tmpRoot.write(file, DOC)
  await claude(server, file, [3, 9, 15].map((n) => ({ op: 'comment' as const, quote: `Paragraph ${n} discusses`, body: `Claude note on ${n}` })))
  const url = `${server.origin}/?file=${encodeURIComponent(file)}`
  await page.goto(url)
  await page.waitForSelector(`[data-testid="${TESTID.editor}"]`)
  await toEditing(page)
  await placeCaret(page, 'Paragraph 2 discusses', 'start')
  await page.keyboard.type('ZZ ', { delay: 4 })
  await page.waitForTimeout(250)
  const fresh = await page.context().newPage()
  await page.close({ runBeforeUnload: true })
  await fresh.goto(url)
  await fresh.waitForSelector(`[data-testid="${TESTID.editor}"]`)
  await expect(fresh.locator(`[data-testid="${TESTID.highlight}"]`)).toHaveCount(3)
  await expect.poll(() => tmpRoot.read(file), { timeout: 10_000 }).toContain('ZZ Paragraph 2 discusses')
  await fresh.waitForTimeout(2_500)
  expect(ok<StatusResult>(await cli.run(['status', cli.abs(file)])).threads).toEqual({ open: 3, resolved: 0, detached: 0 })
  await expect(fresh.locator(`[data-testid="${TESTID.detachedSection}"]`)).toHaveCount(0)
})

// Accept a suggestion in the page; Claude then reads status, pending and thread over the real CLI. A decided suggestion
// thread is done everywhere: status counts it resolved (not open), and its anchor is not "detached" (the accepted text
// replaced the quote; the thread was never orphaned). i3c in p3-r1-open-items.
test.describe('a decided suggestion thread reads as done to Claude', () => {
  test.use({ fixtureFiles: ['basic.md'], docFile: 'basic.md' })

  test('qa3: accept → mdr status counts it resolved; pending and thread say resolved with a placed anchor', async ({ editorPage: ed, cli }) => {
    const abs = cli.abs('basic.md')
    const r = ok<BatchResult>(await cli.batch('basic.md', {
      ops: [
        { op: 'suggest', quote: 'The member rate is reviewed every quarter.', replace: 'The member rate is reviewed every month.', reason: 'cadence' },
        { op: 'comment', quote: 'We launch in Q3.', body: 'Still right?' },
      ],
    }))
    const [sugg, comment] = r.results
    await expect.poll(async () => (await summaries(ed)).length).toBe(1)
    expect(ok<StatusResult>(await cli.run(['status', abs])).threads).toEqual({ open: 2, resolved: 0, detached: 0 })

    expect(await ed.bridge((b, id) => b.accept(id), sugg!.suggestion!)).toMatchObject({ ok: true })
    await ed.session((s) => s.flush())

    await expect.poll(async () => ok<StatusResult>(await cli.run(['status', abs])).threads).toEqual({ open: 1, resolved: 1, detached: 0 })
    const pending = ok<PendingResult>(await cli.run(['pending', abs]))
    const decided = pending.threads.find((t) => t.id === sugg!.thread)!
    expect(decided).toMatchObject({ status: 'resolved', activity: ['accepted'] })
    expect(decided.anchor.state).not.toBe('detached')
    expect(decided.anchor.block).not.toBeNull()
    const thread = ok<ThreadDetail>(await cli.run(['thread', abs, sugg!.thread!]))
    expect(thread.thread.status).toBe('resolved')
    expect(thread.thread.anchor.state).not.toBe('detached')
    // the comment on another block is untouched
    expect(pending.threads.find((t) => t.id === comment!.thread)).toBeUndefined()
  })
})
