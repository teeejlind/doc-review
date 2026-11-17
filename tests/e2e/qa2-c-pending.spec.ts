// tests/e2e/qa2-c-pending.spec.ts (QA round 1, fix pass 2: confirmed 33, 20).
//
// `mdr pending` as Claude reads it after TJ acted in the real page: a retracted comment is still reported when it was
// the thread's only message (the fold drops such a thread, the digest must not).
import type { PendingResult } from '../../shared/types'
import { ok } from './fixtures/p4'
import { MOD, openDoc, placeCaret } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: ['basic.md'], docFile: 'basic.md', viewport: { width: 1440, height: 900 } })

test('qa2-c: TJ deleting an acked comment that was its thread\'s only message is reported by pending', async ({ page, editorPage: ed, cli }) => {
  const abs = cli.abs('basic.md')
  const comment = async (quote: string, body: string): Promise<{ thread: string; comment: string }> => {
    await placeCaret(page, quote, 'select')
    const target = await ed.bridge((b) => b.getSelectionTarget())
    if (target?.kind !== 'anchor') throw new Error('expected a text anchor')
    const r = await ed.session((s, a) => s.createThread(a.anchor, a.body), { anchor: target.anchor, body })
    return { thread: r.thread.id, comment: r.thread.messages[0]!.id }
  }
  const x = await comment('We launch in Q3.', 'X1 root with a reply')
  const y = await comment('Publish the FAQ', 'Y1 only message')
  await ed.session((s) => s.flush())
  // Claude reads TJ's comments, replies on X, and acks everything it has seen
  const first = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(first.threads.map((t) => t.id).sort()).toEqual([x.thread, y.thread].sort())
  ok(await cli.run(['reply', abs, x.thread, '--body', 'Claude reply on X']))
  const second = ok<PendingResult>(await cli.run(['pending', abs]))
  ok(await cli.run(['ack', abs, '--cursor', String(second.cursor), '--since', String(second.since)]))
  expect(ok<PendingResult>(await cli.run(['pending', abs])).empty).toBe(true)

  // TJ retracts both comments
  await ed.session((s, ids) => Promise.all(ids.map((id) => s.deleteComment(id as `c_${string}`))), [x.comment, y.comment])
  await ed.session((s) => s.flush())
  const after = ok<PendingResult>(await cli.run(['pending', abs]))
  expect(after.empty).toBe(false)
  expect(after.threads.map((t) => [t.id, t.activity, t.messages.filter((m) => m.deleted).map((m) => m.id)]).sort()).toEqual([
    [x.thread, ['deleted'], [x.comment]],
    [y.thread, ['deleted'], [y.comment]],
  ].sort())
  expect(after.threads.find((t) => t.id === y.thread)!.anchor.quote).toBe('Publish the FAQ')
})

const SUGGEST_DOC = `# Heading to edit

A paragraph of text. We launch in Q3 with the member rate set.

Second paragraph to split here.

Third paragraph to promote.

| Deal | Rate | Term |
|------|------|------|
| ARV  | 9.0% | 12   |
| BAR  |  | 6    |

- [ ] Todo one
- [x] Todo two

See the [fee schedule](https://example.com/fees) for details.
`

test('qa2-c: pending tells Claude where TJ\'s insertions go and what his format and structure suggestions are', async ({ page, server, tmpRoot, cli }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 's.md', content: SUGGEST_DOC })
  await ed.bridge((b) => b.setMode('suggesting'))
  const abs = cli.abs('s.md')
  await placeCaret(page, 'Q3', 'end')
  await page.keyboard.type(' 2026')
  await placeCaret(page, 'member', 'select')
  await page.keyboard.press(`${MOD}+b`)
  await placeCaret(page, 'Third paragraph', 'start')
  await page.keyboard.type('## ')
  await placeCaret(page, 'Todo one', 'end')
  await ed.testid('taskCheckbox').first().click()
  await placeCaret(page, 'to split', 'start')
  await page.keyboard.press('Enter')
  await placeCaret(page, '9.0%', 'end')
  await page.keyboard.type('5')
  await ed.session((s) => s.flush())
  await expect.poll(async () => ok<PendingResult>(await cli.run(['pending', abs])).threads.length, { timeout: 15_000 }).toBe(6)
  const p = ok<PendingResult>(await cli.run(['pending', abs]))
  const sugg = p.threads.flatMap((t) => t.suggestions)
  const by = (f: (s: (typeof sugg)[number]) => boolean) => sugg.find(f)!
  // an insertion: the source text on both sides
  expect(by((s) => s.hunks.some((h) => h.ins.trim() === '2026')).hunks[0]).toMatchObject({ del: '', before: expect.stringContaining('We launch in Q3'), after: expect.stringContaining('with the member rate') })
  // a table cell: which one
  expect(by((s) => s.hunks.some((h) => h.cell !== undefined)).hunks[0]).toMatchObject({ cell: 'row “ARV”, column “Rate”' })
  // format and structure: a change note, not a bare empty hunks list
  const changes = sugg.map((s) => s.change?.detail).filter(Boolean)
  expect(changes).toEqual(expect.arrayContaining(['Bold: member', 'Heading 2', 'Checked: Todo one', 'Split paragraph']))
  expect(by((s) => s.change?.detail === 'Bold: member').hunks).toEqual([])
})
