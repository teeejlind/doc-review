// tests/unit/core/bridge/export-plan.test.ts. Open threads → Google Docs insertComment / addCommentReply requests
// (core/bridge/export-plan.ts), checked against a live round trip: export-brief.upload.md was uploaded to Google
// Docs (export-brief.read_doc.json is the readback), the planned comments were posted, and
// export-brief-commented.read_doc.json is the readback after posting. Google's own commentAnchors are the ground truth.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseGdoc } from '../../../../core/bridge/gdoc-read'
import { exportThreads, locate, planGdocComments, planGdocReplies, type ExportThread } from '../../../../core/bridge/export-plan'
import { createMd, type Md } from '../../../../core/md/index'
import { ptextOf } from '../../../../core/ptext'
import { load } from '../../../../core/splice/load'
import type { Suggestion, Thread } from '../../../../shared/types'

let md: Md
beforeAll(async () => {
  md = await createMd()
})
afterAll(async () => {
  await md.destroy()
})

const fx = (name: string): string => readFileSync(new URL(`../../../fixtures/gdocs/${name}`, import.meta.url), 'utf8')

function spanOf(ptext: string, quote: string, occurrence = 1): { from: number; to: number } {
  let at = -1
  for (let i = 0; i < occurrence; i++) at = ptext.indexOf(quote, at + 1)
  if (at < 0) throw new Error(`no ${quote}`)
  return { from: at, to: at + quote.length }
}

describe('planGdocComments on the live export round trip', () => {
  it('places every thread exactly where Google recorded it', () => {
    const upload = fx('export-brief.upload.md')
    const L = load(md, upload)
    const ptext = ptextOf(L.doc, L).text
    const t = (id: string, quote: string, body: string, occ = 1, replies: string[] = []): ExportThread => ({
      id, span: spanOf(ptext, quote, occ), quote, messages: [{ who: 'Claude', body }, ...replies.map((r) => ({ who: 'Claude', body: r }))],
    })
    const threads: ExportThread[] = [
      t('t1', 'garden classes', 'Define this for retail readers.'),
      t('t2', 'Segment A first', 'Which segment is A?'),
      t('t3', 'Draft copy\nProofreading pass', 'Cross-item comment'),
      t('t4', '$40k', 'Budget approved?'),
      t('t5', '12% member price', 'Second price mention: legal needs the footnote here.', 2, ['Agreed, adding the footnote.']),
      t('t6', 'café ☕ and 🎉', 'Emoji check'),
      { id: 't7', span: null, quote: '', messages: [{ who: 'Claude', body: 'General: ship by Dec 1.' }] },
    ]
    const g = parseGdoc(JSON.parse(fx('export-brief.read_doc.json')))
    const plan = planGdocComments(threads, g, ptext)
    expect(plan.requests).toHaveLength(7)

    // ground truth: the commented readback's anchors, keyed by comment text
    const after = JSON.parse(fx('export-brief-commented.read_doc.json')) as {
      content: { comments: Array<{ anchorId: string; headPost: { content: string } }>; tabs: Array<{ documentTab: { commentAnchors: Record<string, { ranges: Array<{ startIndex: number; endIndex: number }> }> } }> }
    }
    const anchors = after.content.tabs[0]!.documentTab.commentAnchors
    const truth = new Map(after.content.comments.map((c) => [c.headPost.content, anchors[c.anchorId]!.ranges[0]!]))
    for (const r of plan.requests) {
      const got = truth.get(r.insertComment.content)
      expect(got, r.insertComment.content).toBeDefined()
      expect(r.insertComment.range).toEqual({ startIndex: got!.startIndex, endIndex: got!.endIndex })
    }
    // the second "12% member price", not the first
    const yieldReq = plan.requests.find((r) => r.insertComment.content.startsWith('Claude: Second price'))!
    const first = g.gindex[g.text.indexOf('12% member price')]!
    expect(yieldReq.insertComment.range.startIndex).toBeGreaterThan(first)
    // the doc-level thread anchors on the title and says it is general
    expect(plan.requests[6]!.insertComment.content).toBe('(General comment) Claude: General: ship by Dec 1.')
    expect(plan.placed[4]!.replies).toEqual(['Claude: Agreed, adding the footnote.'])
  })

  it('replies need one comment id per request, in order', () => {
    const placed = [
      { thread: 'a', startIndex: 1, endIndex: 2, quote: 'x', replies: [] },
      { thread: 'b', startIndex: 3, endIndex: 4, quote: 'y', replies: ['Claude: one', 'TJ: two'] },
    ]
    expect(planGdocReplies(placed, ['c1', 'c2'])).toEqual([
      { addCommentReply: { commentId: 'c2', post: { content: 'Claude: one' } } },
      { addCommentReply: { commentId: 'c2', post: { content: 'TJ: two' } } },
    ])
    expect(() => planGdocReplies(placed, ['c1'])).toThrow(/expected 2 comment ids/)
  })
})

describe('locate', () => {
  it('same hit count → same occurrence; otherwise nearest relative position; then whitespace-collapsed', () => {
    expect(locate('a x b x c x', 'x', { occ: 2, total: 3, srcFrom: 4, srcLen: 11 })).toEqual({ from: 6, to: 7 })
    expect(locate('x . . . . . . . . x', 'x', { occ: 3, total: 3, srcFrom: 90, srcLen: 100 })).toEqual({ from: 18, to: 19 })
    expect(locate('one  two\nthree', 'one two three', { occ: 1, total: 1, srcFrom: 0, srcLen: 13 })).toEqual({ from: 0, to: 14 })
    expect(locate('abc', 'zzz', { occ: 1, total: 1, srcFrom: 0, srcLen: 3 })).toBeNull()
  })
})

describe('exportThreads', () => {
  const thread = (over: Partial<Thread>): Thread => ({
    id: 't_1' as Thread['id'], kind: 'comment', status: 'open', autoResolved: false,
    anchor: { kind: 'text', quote: 'abc', prefix: '', suffix: '', hint: { rev: 1, pos: 0, block: 0, blockHash: '0000000000000000' as never, offsetInBlock: 0 } },
    lastAnchor: { kind: 'doc' }, resolution: { state: 'exact', from: 0, to: 3 }, detached: false, createdBy: 'TJ', createdSeq: 1, lastSeq: 1,
    messages: [{ id: 'c_1' as never, by: 'TJ', at: '2026-11-16T00:00:00.000Z', body: 'hello', seq: 1 }],
    suggestions: [], unread: 0, ...over,
  })
  it('keeps open threads with messages, names the human, skips resolved and deleted messages, orders by position', () => {
    const out = exportThreads([
      thread({ id: 't_2' as never, resolution: { state: 'exact', from: 4, to: 7 }, messages: [{ id: 'c_2' as never, by: 'Claude', at: 'x', body: 'later', seq: 2 }] }),
      thread({}),
      thread({ id: 't_3' as never, status: 'resolved' }),
      thread({ id: 't_4' as never, messages: [{ id: 'c_4' as never, by: 'TJ', at: 'x', body: '', seq: 3, deleted: true }] }),
      thread({ id: 't_5' as never, detached: true, resolution: { state: 'detached' }, lastAnchor: { kind: 'text', quote: 'gone', prefix: '', suffix: '', hint: { rev: 1, pos: 0, block: 0, blockHash: '0000000000000000' as never, offsetInBlock: 0 } } }),
    ], [], 'abc def', 'Ana Díaz')
    expect(out.map((t) => [t.id, t.quote, t.span, t.messages[0]!.who])).toEqual([
      ['t_1', 'abc', { from: 0, to: 3 }, 'Ana Díaz'],
      ['t_2', 'def', { from: 4, to: 7 }, 'Claude'],
      ['t_5', 'gone', null, 'Ana Díaz'],
    ])
  })
  it('a pending suggestion travels as a comment that says what it would change', () => {
    const s = { id: 's_1', thread: 't_1', by: 'Claude', status: 'pending', hunks: [{ del: 'abc', ins: 'xyz', at: 0 }], base: 'abc', proposed: 'xyz' } as unknown as Suggestion
    const out = exportThreads([thread({ kind: 'suggestion', messages: [], suggestions: ['s_1' as never] })], [s], 'abc', 'TJ')
    expect(out[0]!.messages).toEqual([{ who: 'Claude', body: 'Suggested edit: replace “abc” with “xyz”' }])
  })
})
