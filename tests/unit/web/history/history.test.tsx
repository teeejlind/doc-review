// tests/unit/web/history/history.test.tsx (P3; CONTRACTS §10 UI, §11.6, §12.15 historyPanel / historyVersion /
// historyPick / historyDiff / historyRestore, §14 P3 unit test "history diff rendering").
//
// The diff view (folding, author colours, inserted text underlined and deleted text struck through, the word-level
// replace), and the panel: the timeline, the default range, From / To picks, Restore closing the panel only once the
// session's restore has resolved, and a 409 STALE_REVISION re-offering the restore.
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import type { DiffBlock, HistoryDiff, HistoryRef, VersionMeta } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { actorLabel, causeLabel, cleanSegments, diffItems, inlineSegments, plainBlockText, restoredText, whenLabel } from '../../../../web/src/history/diff-view'
import { defaultRange, DiffView, HistoryPanel } from '../../../../web/src/history/HistoryPanel'

afterEach(cleanup)

const eq = (t: string): DiffBlock => ({ op: 'equal', before: t, after: t, by: [], lastBy: null })

function meta(n: number, o: Partial<VersionMeta> = {}): VersionMeta {
  return {
    v: `v${n}`, n, rev: n, hash: `${n}`.padStart(64, '0'), by: 'TJ', cause: 'tj-session', at: '2026-10-15T12:00:00.000Z', size: 100,
    revs: [n, n], blocksChanged: 1, ...o,
  }
}

const sampleDiff: HistoryDiff = {
  ok: true,
  from: meta(2),
  to: { current: true, rev: 9, hash: 'f'.repeat(64) },
  blocks: [
    eq('# Title'),
    eq('Intro paragraph.'),
    eq('Second paragraph.'),
    eq('Third paragraph.'),
    { op: 'replace', before: 'We launch in Q3.', after: 'We launch in Q4.', by: ['Claude'], lastBy: 'Claude', inline: [[0, 'We launch in '], [-1, 'Q3'], [1, 'Q4'], [0, '.']] },
    eq('Fifth paragraph.'),
    eq('Sixth paragraph.'),
    { op: 'insert', after: 'A new closing line.', by: ['TJ', 'Claude'], lastBy: 'TJ' },
    { op: 'delete', before: 'An old footnote.', by: ['external'], lastBy: 'external' },
  ],
}

describe('diff-view helpers', () => {
  it('diffItems shows changes with one block of context and folds longer unchanged runs', () => {
    const items = diffItems(sampleDiff.blocks)
    expect(items.map((i) => (i.type === 'fold' ? `fold:${i.from}+${i.count}` : `${i.block.op}:${i.index}${i.context ? 'c' : ''}`))).toEqual([
      'fold:0+3',
      'equal:3c',
      'replace:4',
      'equal:5c',
      'equal:6c',
      'insert:7',
      'delete:8',
    ])
  })

  it('inlineSegments merges runs and falls back to before/after', () => {
    expect(inlineSegments(sampleDiff.blocks[4]!)).toEqual([
      { kind: 'same', text: 'We launch in ' },
      { kind: 'del', text: 'Q3' },
      { kind: 'ins', text: 'Q4' },
      { kind: 'same', text: '.' },
    ])
    expect(inlineSegments({ op: 'replace', before: 'a', after: 'b', by: [], lastBy: null })).toEqual([{ kind: 'del', text: 'a' }, { kind: 'ins', text: 'b' }])
  })

  it('labels', () => {
    expect(causeLabel(meta(3, { cause: 'restore', restoredFrom: 'v1' }))).toBe('Restored v1')
    expect(causeLabel(meta(3, { cause: 'claude-write', by: 'Claude' }))).toBe('Claude’s edit')
    const now = new Date('2026-10-15T18:00:00')
    expect(whenLabel(new Date('2026-10-15T09:05:00').toISOString(), now)).toMatch(/^Today, /)
    expect(whenLabel(new Date('2026-10-14T09:05:00').toISOString(), now)).toMatch(/^Yesterday, /)
    expect(defaultRange({ versions: [meta(3), meta(2)], unsnapshotted: false })).toEqual({ from: 'v2', to: 'current' })
    expect(defaultRange({ versions: [meta(3), meta(2)], unsnapshotted: true })).toEqual({ from: 'v3', to: 'current' })
    expect(defaultRange({ versions: [], unsnapshotted: true })).toEqual({ from: 'current', to: 'current' })
  })
})

describe('diff-view: words a colleague reads (QA3 theme-polish)', () => {
  it('plainBlockText drops the markdown markers a block starts its lines with', () => {
    expect(plainBlockText('### Reporting and trends')).toBe('Reporting and trends')
    expect(plainBlockText('- Launch the pilot\n- Review the results')).toBe('Launch the pilot\nReview the results')
    expect(plainBlockText('1. First\n2. Second')).toBe('First\nSecond')
    expect(plainBlockText('> A quoted line')).toBe('A quoted line')
    expect(plainBlockText('- [x] Done thing')).toBe('Done thing')
    // fences, tables and HTML keep their source: the markers there are the content
    expect(plainBlockText('```js\nconst a = 1\n```')).toBe('```js\nconst a = 1\n```')
    expect(plainBlockText('| a | b |\n| - | - |')).toBe('| a | b |\n| - | - |')
    expect(plainBlockText('A paragraph about 1. things')).toBe('A paragraph about 1. things')
  })

  it('cleanSegments strips the markers from a word diff, whichever segment carries them', () => {
    expect(cleanSegments('## What is next', '## What comes next', [[0, '## What '], [-1, 'is'], [1, 'comes'], [0, ' next']])).toEqual([
      { kind: 'same', text: 'What ' },
      { kind: 'del', text: 'is' },
      { kind: 'ins', text: 'comes' },
      { kind: 'same', text: ' next' },
    ])
    // a bullet turned numbered: the markers go, nothing else is left to show
    expect(cleanSegments('- a', '1. a', [[-1, '-'], [1, '1.'], [0, ' a']])).toEqual([{ kind: 'same', text: 'a' }])
    // a marker on a later line
    expect(cleanSegments('- one\n- two', '- one\n- three', [[0, '- one\n- '], [-1, 'two'], [1, 'three']])).toEqual([
      { kind: 'same', text: 'one\n' },
      { kind: 'del', text: 'two' },
      { kind: 'ins', text: 'three' },
    ])
  })

  it('says things in plain words', () => {
    expect(causeLabel(meta(1, { cause: 'baseline', by: 'external' }))).toBe('Opened for review')
    expect(causeLabel(meta(2, { cause: 'external', by: 'external' }))).toBe('Edited outside the review (Claude or another app)')
    expect(actorLabel('external')).toBe('Another app')
    for (const w of [causeLabel(meta(1, { cause: 'baseline' })), causeLabel(meta(2, { cause: 'external' })), actorLabel('external')]) expect(w).not.toMatch(/mdr/i)
  })
})

describe('<DiffView>: history diff rendering', () => {
  it('colours each changed block by its last author; insertions are <ins>, deletions <del>', () => {
    // the human's actor id stays 'TJ' (data-by); the label is the display name the server injects
    const tag = document.createElement('meta')
    tag.name = 'mdr-user-name'
    tag.content = 'Teej'
    document.head.appendChild(tag)
    const { container } = render(<DiffView diff={sampleDiff} error={null} loading={false} />)
    tag.remove()
    const root = container.querySelector(`[data-testid="${TESTID.historyDiff}"]`)!
    expect(root.textContent).toContain('From v2 to the current version')
    expect(root.textContent).toContain('3 blocks changed')
    expect(root.textContent).toContain('by Claude, Teej, Another app')
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mdr-hd-block'))
    const changed = blocks.filter((b) => b.dataset.op !== 'equal')
    expect(changed.map((b) => `${b.dataset.op}:${b.dataset.by}`)).toEqual(['replace:Claude', 'insert:TJ', 'delete:external'])
    const replace = changed[0]!
    expect(replace.querySelector('del')!.textContent).toBe('Deleted: Q3')
    expect(replace.querySelector('ins')!.textContent).toBe('Inserted: Q4')
    expect(replace.querySelector('.mdr-hd-by')!.textContent).toBe('Claude')
    expect(changed[1]!.querySelector('ins')!.textContent).toContain('A new closing line.')
    expect(changed[1]!.querySelector('.mdr-hd-by')!.textContent).toBe('Teej (also Claude)')
    expect(changed[2]!.querySelector('del')!.textContent).toContain('An old footnote.')
    expect(changed[2]!.querySelector('.mdr-hd-by')!.textContent).toBe('Another app')
  })

  it('a folded run opens on a click', () => {
    const { container } = render(<DiffView diff={sampleDiff} error={null} loading={false} />)
    const fold = container.querySelector('.mdr-hd-fold') as HTMLButtonElement
    expect(fold.textContent).toBe('3 unchanged blocks')
    act(() => fold.click())
    expect(container.querySelector('.mdr-hd-fold')).toBeNull()
    expect(container.querySelectorAll('.mdr-hd-block[data-op="equal"]')).toHaveLength(6)
  })

  it('shows headings and list items as text, without their markdown markers', () => {
    const diff: HistoryDiff = {
      ...sampleDiff,
      blocks: [
        { op: 'replace', before: '### Reporting and trends', after: '### Reporting and results', by: ['TJ'], lastBy: 'TJ', inline: [[0, '### Reporting and '], [-1, 'trends'], [1, 'results']] },
        { op: 'insert', after: '## What is next', by: ['Claude'], lastBy: 'Claude' },
        { op: 'delete', before: '- Launch the pilot\n- Review it', by: ['external'], lastBy: 'external' },
      ],
    }
    const { container } = render(<DiffView diff={diff} error={null} loading={false} />)
    const text = container.querySelector('.mdr-history-blocks')!.textContent!
    expect(text).not.toMatch(/#|(^|\n)- /)
    expect(text).toContain('Reporting and ')
    expect(text).toContain('What is next')
    expect(text).toContain('Launch the pilot')
    expect(container.querySelectorAll('.mdr-hd-block[data-kind="heading"]')).toHaveLength(2)
  })

  it('no changes, an error, and loading each say so', () => {
    const same: HistoryDiff = { ...sampleDiff, blocks: [eq('a'), eq('b')] }
    const { container, rerender } = render(<DiffView diff={same} error={null} loading={false} />)
    expect(container.textContent).toContain('These two versions have the same text.')
    rerender(<DiffView diff={null} error="Couldn’t compare these versions: boom" loading={false} />)
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('boom')
    rerender(<DiffView diff={null} error={null} loading />)
    expect(container.textContent).toContain('Comparing…')
  })
})

describe('<HistoryPanel>', () => {
  const versions = [meta(3, { by: 'Claude', cause: 'claude-write', hash: 'c'.repeat(64) }), meta(2), meta(1, { by: 'external', cause: 'baseline' })]
  function setup(o: { unsnapshotted?: boolean } = {}) {
    const session = createFakeDocSession({ file: 'doc.md', history: { versions, markdown: { v1: '# One\n', v2: '# Two\n', v3: '# Three\n' } } })
    const list = session.history.list.bind(session.history)
    session.history.list = async () => ({ ...(await list()), currentHash: o.unsnapshotted ? 'e'.repeat(64) : 'c'.repeat(64), unsnapshotted: o.unsnapshotted ?? false })
    const diffs: Array<[HistoryRef, HistoryRef]> = []
    session.history.diff = async (from, to) => {
      diffs.push([from, to])
      return { ...sampleDiff, from: versions.find((v) => v.v === from) ?? { current: true, rev: 9, hash: 'f'.repeat(64) } }
    }
    const onClose = vi.fn()
    const r = render(<HistoryPanel session={session} onClose={onClose} />)
    return { session, onClose, diffs, r }
  }
  const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.historyVersion}"]`))
  const pick = (v: string, role: 'from' | 'to'): HTMLButtonElement => document.querySelector(`[data-testid="${TESTID.historyPick}"][data-v="${v}"][data-role="${role}"]`) as HTMLButtonElement

  it('lists the current text and every version, newest first, as a non-modal dialog', async () => {
    setup()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const panel = document.querySelector(`[data-testid="${TESTID.historyPanel}"]`)!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('false')
    expect(rows().map((r) => `${r.dataset.v}:${r.dataset.by}`)).toEqual(['current:current', 'v3:Claude', 'v2:TJ', 'v1:external'])
    expect(rows()[1]!.textContent).toContain('Claude’s edit')
    // the current row has no Restore; the version equal to the current text can't be restored onto itself
    expect(rows()[0]!.querySelector(`[data-testid="${TESTID.historyRestore}"]`)).toBeNull()
    expect((document.querySelector(`[data-testid="${TESTID.historyRestore}"][data-v="v3"]`) as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector(`[data-testid="${TESTID.historyRestore}"][data-v="v2"]`) as HTMLButtonElement).disabled).toBe(false)
  })

  it('the first version reads "Original" with no outside-app byline (T2 polish #36)', async () => {
    setup()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const first = rows().find((r) => r.dataset.v === 'v1')!
    expect(first.querySelector('.mdr-history-who')!.textContent).toBe('Original')
    expect(first.querySelector('.mdr-history-detail')!.textContent).toContain('Opened for review')
    expect(first.textContent).not.toContain('Another app')
    // a later outside edit keeps its own byline
    expect(rows().find((r) => r.dataset.v === 'current')!.querySelector('.mdr-history-who')!.textContent).toBe('Current version')
  })

  it('defaults to the previous version → current, and From / To re-run the diff', async () => {
    const s = setup()
    await waitFor(() => expect(s.diffs).toEqual([['v2', 'current']]))
    expect(pick('v2', 'from').getAttribute('aria-pressed')).toBe('true')
    expect(pick('current', 'to').getAttribute('aria-pressed')).toBe('true')
    act(() => pick('v1', 'from').click())
    await waitFor(() => expect(s.diffs.at(-1)).toEqual(['v1', 'current']))
    act(() => pick('v3', 'to').click())
    await waitFor(() => expect(s.diffs.at(-1)).toEqual(['v1', 'v3']))
    expect(rows().find((r) => r.dataset.v === 'v1')!.dataset.from).toBe('true')
    expect(rows().find((r) => r.dataset.v === 'v3')!.dataset.to).toBe('true')
    await waitFor(() => expect(document.querySelector(`[data-testid="${TESTID.historyDiff}"] .mdr-hd-block[data-op="replace"]`)).not.toBeNull())
  })

  it('with unsnapshotted edits the default is the newest version → current', async () => {
    const s = setup({ unsnapshotted: true })
    await waitFor(() => expect(s.diffs).toEqual([['v3', 'current']]))
  })

  it('Restore closes the panel only after session.history.restore resolves', async () => {
    const s = setup()
    await waitFor(() => expect(rows()).toHaveLength(4))
    let resolve!: () => void
    const restore = s.session.history.restore.bind(s.session.history)
    s.session.history.restore = (v) => new Promise((res) => (resolve = () => void restore(v).then(res)))
    act(() => (document.querySelector(`[data-testid="${TESTID.historyRestore}"][data-v="v2"]`) as HTMLButtonElement).click())
    await waitFor(() => expect(document.querySelector(`[data-testid="${TESTID.historyRestore}"][data-v="v2"]`)!.textContent).toBe('Restoring…'))
    expect(s.onClose).not.toHaveBeenCalled()
    await act(async () => resolve())
    await waitFor(() => expect(s.onClose).toHaveBeenCalledTimes(1))
    expect(s.session.getSnapshot().markdown).toBe('# Two\n')
  })

  it('409 STALE_REVISION reloads the list and re-offers the restore', async () => {
    const s = setup()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const listSpy = vi.spyOn(s.session.history, 'list')
    s.session.history.restore = () => Promise.reject(Object.assign(new Error('stale'), { code: 'STALE_REVISION', status: 409 }))
    await act(async () => (document.querySelector(`[data-testid="${TESTID.historyRestore}"][data-v="v2"]`) as HTMLButtonElement).click())
    await waitFor(() => expect(document.querySelector('.mdr-history-note')?.textContent).toContain('restore v2 again'))
    expect(listSpy).toHaveBeenCalled()
    expect(s.onClose).not.toHaveBeenCalled()
    expect((document.querySelector(`[data-testid="${TESTID.historyRestore}"][data-v="v2"]`) as HTMLButtonElement).disabled).toBe(false)
  })

  it('onRestored gets the RestoreResponse (§13 row 64: detach and stale results are reported)', async () => {
    const s = setup()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const onRestored = vi.fn()
    cleanup()
    render(<HistoryPanel session={s.session} onClose={() => undefined} onRestored={onRestored} />)
    await waitFor(() => expect(rows()).toHaveLength(4))
    await act(async () => (document.querySelector(`[data-testid="${TESTID.historyRestore}"][data-v="v2"]`) as HTMLButtonElement).click())
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1))
    expect(onRestored.mock.calls[0]![1]).toBe('v2')
    expect(restoredText('v2', { detached: [], staled: [] })).toBe('Restored v2.')
    expect(restoredText('v3', { detached: ['a', 'b'], staled: ['s'] })).toBe('Restored v3. 2 comments lost their text and moved to Detached. 1 suggestion is out of date now.')
    expect(restoredText('v3', { detached: ['a'], staled: ['s', 't'] })).toBe('Restored v3. 1 comment lost its text and moved to Detached. 2 suggestions are out of date now.')
  })

  it('is not a second banner landmark (the top bar is the page’s banner)', async () => {
    setup()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const panel = document.querySelector(`[data-testid="${TESTID.historyPanel}"]`)!
    expect(panel.querySelectorAll('header, [role="banner"]')).toHaveLength(0)
  })

  it('a document with nothing to compare says so in one line: no Revision 0 row, no empty diff', async () => {
    const session = createFakeDocSession({ file: 'doc.md', history: { versions: [], markdown: {} } })
    render(<HistoryPanel session={session} onClose={() => undefined} />)
    await waitFor(() => expect(document.body.textContent).toContain('No earlier versions yet'))
    const panel = document.querySelector(`[data-testid="${TESTID.historyPanel}"]`)!
    expect(panel.textContent).not.toMatch(/Revision \d|not in the history yet|same text|current version to the current/)
    expect(panel.querySelector(`[data-testid="${TESTID.historyDiff}"]`)).toBeNull()
    expect(panel.querySelectorAll(`[data-testid="${TESTID.historyVersion}"]`)).toHaveLength(0)
  })

  it('Esc and the close button close it', async () => {
    const s = setup()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const panel = document.querySelector(`[data-testid="${TESTID.historyPanel}"]`) as HTMLElement
    act(() => void panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(s.onClose).toHaveBeenCalledTimes(1)
    act(() => (panel.querySelector('button[aria-label="Close version history"]') as HTMLButtonElement).click())
    expect(s.onClose).toHaveBeenCalledTimes(2)
  })
})
