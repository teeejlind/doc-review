// tests/unit/web/threads/suggestion-view.test.ts (P3; CONTRACTS §6.3, §6.6–§6.8, §13 rows 41, 72).
import { describe, expect, it } from 'vitest'
import type { Suggestion, SuggestionSummary } from '../../../../shared/types'
import { clip, isCodeRecord, kindOf, labelOf, rowActions, rowState, stateLine, titleOf, togetherLabel } from '../../../../web/src/threads/suggestion-view'

const rec = (o: Partial<Suggestion> = {}): Suggestion =>
  ({
    id: 's_1', thread: 't_1', by: 'Claude', status: 'pending', hunks: [{ del: 'a', ins: 'b', at: 0 }], base: 'a', proposed: 'b',
    range: { start: 0, end: 1, rev: 0 }, createdSeq: 1, updatedSeq: 1, located: { start: 0, end: 1 }, anchor: {} as never, ...o,
  }) as Suggestion
const sum = (o: Partial<SuggestionSummary> = {}): SuggestionSummary => ({ id: 's_1', by: 'Claude', kind: 'replace', deletedText: 'a', insertedText: 'b', hunkCount: 1, placed: true, ...o })

describe('suggestion rows', () => {
  it('kind comes from the summary, else from the hunks (format when deleted and inserted text match)', () => {
    expect(kindOf(rec(), sum({ kind: 'structure' }))).toBe('structure')
    expect(kindOf(rec({ hunks: [{ del: 'x', ins: 'x', at: 0 }] }))).toBe('format')
    expect(kindOf(rec({ hunks: [{ del: '', ins: 'x', at: 0 }] }))).toBe('insert')
    expect(kindOf(rec({ hunks: [{ del: 'x', ins: '', at: 0 }] }))).toBe('delete')
    expect(kindOf(rec({ hunks: [] }))).toBe('structure')
  })

  it('state: pending, stale, "Shown as a diff" (SCHEMA), "Can’t place this inline" (BASE_NOT_FOUND / ID_COLLISION), decided', () => {
    expect(rowState(rec(), sum())).toBe('pending')
    expect(rowState(rec({ status: 'stale' }), sum())).toBe('stale')
    expect(rowState(rec(), sum({ placed: false, unplaced: 'SCHEMA' }))).toBe('schema')
    expect(rowState(rec(), sum({ placed: false, unplaced: 'BASE_NOT_FOUND' }))).toBe('unplaced')
    expect(rowState(rec(), sum({ placed: false, unplaced: 'ID_COLLISION' }))).toBe('unplaced')
    expect(rowState(rec({ status: 'accepted' }))).toBe('decided')
    expect(stateLine(rec(), sum({ placed: false, unplaced: 'SCHEMA' }))!.tag).toBe('Shown as a diff')
    expect(stateLine(rec(), sum({ placed: false, unplaced: 'BASE_NOT_FOUND' }))!.tag).toBe('Can’t place this inline')
    expect(stateLine(rec({ status: 'stale', staleReason: 'OVERLAP' }))).toMatchObject({ tag: 'Out of date', text: expect.stringContaining('overlaps') })
    expect(stateLine(rec({ status: 'rejected', decidedBy: 'TJ' }))!.tag).toBe('Rejected by You') // the display name; no tag → "You"
    expect(stateLine(rec({ status: 'withdrawn', decidedBy: 'Claude' }))!.tag).toBe('Withdrawn')
    expect(stateLine(rec(), sum())).toBeNull()
  })

  it('actions: pending = Accept + Reject; stale = greyed Accept, Dismiss and Copy replacement (§6.7, row 41); decided = none', () => {
    expect(rowActions(rec())).toEqual({ accept: 'on', reject: true, dismiss: false, copyReplacement: false })
    expect(rowActions(rec({ status: 'stale' }))).toEqual({ accept: 'off', reject: false, dismiss: true, copyReplacement: true })
    expect(rowActions(rec({ status: 'accepted' }))).toEqual({ accept: null, reject: false, dismiss: false, copyReplacement: false })
  })

  it('a multi-hunk record is one decision: "N changes, accepted together" (D31)', () => {
    expect(togetherLabel(rec({ hunks: [{ del: 'a', ins: 'b', at: 0 }, { del: 'c', ins: 'd', at: 5 }] }))).toBe('2 changes, accepted together')
    expect(togetherLabel(rec(), sum({ hunkCount: 3 }))).toBe('3 changes, accepted together')
    expect(togetherLabel(rec())).toBeNull()
  })

  it('code-block records show monospace; long hunks are clipped around a middle ellipsis', () => {
    expect(isCodeRecord(rec({ base: '```js\nx\n```' }))).toBe(true)
    expect(isCodeRecord(rec({ base: 'plain', proposed: 'text' }))).toBe(false)
    const long = 'x'.repeat(1000)
    const c = clip(long, 100)
    expect(c.length).toBeLessThanOrEqual(101)
    expect(c).toContain(' … ')
    expect(clip('short', 100)).toBe('short')
  })
})

describe('what a row says it does (QA round 1, confirmed 28)', () => {
  const textless = (base: string, proposed: string, hunks: Suggestion['hunks'] = []): Suggestion => rec({ base, proposed, hunks })

  it('a text change is labelled by what its hunks do, even when the editor\'s marks read differently', () => {
    expect(labelOf(rec({ hunks: [{ del: '', ins: ' (see below)', at: 3 }] }))).toBe('Add')
    expect(labelOf(rec({ hunks: [{ del: 'waitlist', ins: '', at: 3 }] }))).toBe('Delete')
    // a typed digit inside a table cell is a replacement on the card: the marks only show the inserted "5"
    expect(labelOf(rec({ hunks: [{ del: '9.0%', ins: '9.05%', at: 3 }] }), sum({ kind: 'insert' }))).toBe('Replace')
  })

  it('format and structure records name the change instead of "Format" / "Structure change"', () => {
    const P = 'We set the member rate.'
    expect(labelOf(textless(P, P.replace('member', '**member**')), sum({ kind: 'format' }))).toBe('Bold: member')
    expect(labelOf(textless('Second.', '## Second.'), sum({ kind: 'structure' }))).toBe('Heading 2')
    expect(labelOf(textless('- [ ] Todo one\n- [x] Todo two', '- [x] Todo one\n- [x] Todo two'))).toBe('Checked: Todo one')
    expect(labelOf(textless('See [fee schedule](https://example.com/fees).', 'See [fee schedule](https://example.com/pricing).'))).toBe('Link: /fees → /pricing')
    expect(labelOf(textless('One two.', 'One\n\ntwo.', [{ del: ' ', ins: '\n', at: 3 }]))).toBe('Split paragraph')
  })

  it('titleOf adds the change itself for a collapsed card: "Add: (see below)", "Replace: Q3 → Q4", "Bold: member"', () => {
    expect(titleOf(rec({ hunks: [{ del: '', ins: ' (see below)', at: 3 }] }))).toBe('Add: (see below)')
    expect(titleOf(rec({ hunks: [{ del: 'Q3', ins: 'Q4', at: 3 }] }))).toBe('Replace: Q3 → Q4')
    expect(titleOf(rec({ hunks: [{ del: 'waitlist', ins: '', at: 3 }] }))).toBe('Delete: waitlist')
    expect(titleOf(rec({ hunks: [{ del: 'a', ins: 'b', at: 0 }, { del: 'c', ins: 'd', at: 5 }] }))).toBe('Replace: a → b (+1 more)')
    expect(titleOf(textless('the member', 'the **member**'))).toBe('Bold: member')
    expect(titleOf(rec({ hunks: [{ del: '', ins: 'x'.repeat(100), at: 0 }] })).length).toBeLessThan(60)
  })
})

