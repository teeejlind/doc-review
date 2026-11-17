// tests/unit/web/shell/banners.test.tsx (P3; CONTRACTS §12.14, §12.15).
//
// Every SessionBanner kind from FakeDocSession.emit: its copy, its role, and that its action calls the right session
// method; and both RecoveredDraft reasons: their copy and actions (Copy in the gesture, Keep mine, Dismiss).
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID, TEST_ACTIONS } from '../../../../shared/constants'
import type { RecoveredDraft, SessionBanner } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { Banner } from '../../../../web/src/shell/Banner'
import { RecoveredCard, RECOVERED_TITLE, useRecoveredDraft } from '../../../../web/src/threads/RecoveredCard'

afterEach(cleanup)

const cases: Array<{ banner: SessionBanner; text: string; action: (typeof TEST_ACTIONS.bannerAction)[number] | null; method: string | null; role: 'alert' | 'status' }> = [
  { banner: { kind: 'doc-removed', canRecreate: true }, text: 'This file was moved or deleted. Your copy is safe in this tab.', action: 'recreate', method: 'recreate', role: 'alert' },
  { banner: { kind: 'doc-removed', canRecreate: false }, text: 'This file was moved or deleted. Your copy is safe in this tab.', action: null, method: null, role: 'alert' },
  { banner: { kind: 'review-reset', previousDocId: null, docId: null }, text: 'Review data for this file was reset. Earlier comments and suggestions are gone from this view.', action: 'dismiss', method: 'dismissBanner', role: 'status' },
  { banner: { kind: 'connection-lost' }, text: 'This page lost its connection to the review. Reload to keep going. Anything you typed since the last save is kept in this browser and comes back after the reload.', action: 'reload', method: 'reload', role: 'alert' },
  { banner: { kind: 'contract-mismatch', expected: 'aaaa', actual: 'bbbb' }, text: 'This page is out of date.', action: 'reload', method: 'reload', role: 'alert' },
  { banner: { kind: 'read-only', code: 'NOT_UTF8', message: 'This file is not UTF-8, so it opens read-only.' }, text: 'This file is not UTF-8, so it opens read-only. To read and edit it here, save it as UTF-8 text (or ask Claude to convert it), then reload.', action: null, method: null, role: 'status' },
  { banner: { kind: 'read-only', code: 'NOT_UTF8', message: 'c4-latin1.md is not valid UTF-8' }, text: 'c4-latin1.md is not valid UTF-8. To read and edit it here, save it as UTF-8 text (or ask Claude to convert it), then reload.', action: null, method: null, role: 'status' },
  { banner: { kind: 'read-only', code: 'TOO_LARGE', message: 'This file is over 5 MB, so it opens read-only.' }, text: 'This file is over 5 MB, so it opens read-only. Split it into smaller files to edit it here.', action: null, method: null, role: 'status' },
  { banner: { kind: 'read-only', code: 'SIDECAR_CORRUPT', message: 'The review data is damaged.' }, text: 'The review data is damaged. Ask Claude to run mdr doctor.', action: null, method: null, role: 'status' },
  { banner: { kind: 'read-only', code: 'SIDECAR_SCHEMA_UNSUPPORTED', message: 'The review data is from a newer mdr.' }, text: 'The review data is from a newer mdr. Ask Claude to run mdr doctor.', action: null, method: null, role: 'status' },
  { banner: { kind: 'tab-not-leader' }, text: 'This document is open in another tab, so this tab is read-only. Switch to that tab, or take over to edit here.', action: 'take-over', method: 'takeOver', role: 'status' },
]

describe('Banner (§12.14)', () => {
  it.each(cases)('$banner.kind ($banner.code): copy, role and action', ({ banner, text, action, method, role }) => {
    const session = createFakeDocSession({ banner })
    const { container } = render(<Banner banner={banner} session={session} />)
    const el = container.querySelector(`[data-testid="${TESTID.banner}"]`) as HTMLElement
    expect(el.dataset.kind).toBe(banner.kind)
    expect(el.getAttribute('role')).toBe(role)
    expect(el.querySelector('.mdr-banner-text')!.textContent).toBe(text)
    const btn = el.querySelector(`[data-testid="${TESTID.bannerAction}"]`) as HTMLButtonElement | null
    if (action === null) {
      expect(btn).toBeNull()
      return
    }
    expect(btn!.dataset.action).toBe(action)
    expect(TEST_ACTIONS.bannerAction).toContain(action)
    act(() => btn!.click())
    expect(session.calls.map((c) => c.method)).toContain(method)
  })
})

const draft = (reason: RecoveredDraft['reason']): RecoveredDraft => ({ reason, markdown: '# My copy\n\nEverything I typed.\n', baseRev: 3, savedAt: '2026-10-15T12:00:00.000Z' })

function Harness({ session }: { session: ReturnType<typeof createFakeDocSession> }) {
  const d = useRecoveredDraft(session)
  return d ? <RecoveredCard draft={d} session={session} /> : null
}

describe('recovered-draft card (§12.4, §12.5, §12.14)', () => {
  it('merge-failed: "Couldn’t merge: your copy is kept" with Copy, Keep mine and Dismiss', async () => {
    const writes: string[] = []
    const session = createFakeDocSession({ clipboard: { writeText: async (s) => void writes.push(s) } })
    const { container } = render(<Harness session={session} />)
    expect(container.querySelector(`[data-testid="${TESTID.recoveredCard}"]`)).toBeNull()
    act(() => session.emit({ recovered: draft('merge-failed') }))
    const card = container.querySelector(`[data-testid="${TESTID.recoveredCard}"]`) as HTMLElement
    expect(card.dataset.kind).toBe('merge-failed')
    expect(card.getAttribute('role')).toBe('alert')
    expect(card.textContent).toContain(RECOVERED_TITLE['merge-failed'])
    expect(RECOVERED_TITLE['merge-failed']).toBe('Couldn’t merge: your copy is kept')
    const actions = Array.from(card.querySelectorAll<HTMLButtonElement>(`[data-testid="${TESTID.cardAction}"]`))
    expect(actions.map((b) => b.dataset.action)).toEqual(['copy', 'keep-mine', 'dismiss'])
    for (const b of actions) expect(TEST_ACTIONS.cardAction).toContain(b.dataset.action)
    // Copy writes inside the click (the session copies before its first await)
    act(() => actions[0]!.click())
    expect(session.calls.map((c) => c.method)).toContain('copyRecoveredDraft')
    expect(writes).toEqual([draft('merge-failed').markdown])
    await waitFor(() => expect(actions[0]!.textContent).toBe('Copied'))
    await act(async () => actions[1]!.click())
    expect(session.calls.map((c) => c.method)).toContain('keepRecoveredDraft')
    expect(container.querySelector(`[data-testid="${TESTID.recoveredCard}"]`)).toBeNull()
  })

  it('schema-invalid: "Couldn’t restore your unsaved edits" with Copy and Dismiss only (it can’t be loaded)', () => {
    const session = createFakeDocSession({ recovered: draft('schema-invalid') })
    const { container } = render(<Harness session={session} />)
    const card = container.querySelector(`[data-testid="${TESTID.recoveredCard}"]`) as HTMLElement
    expect(card.dataset.kind).toBe('schema-invalid')
    expect(card.textContent).toContain('Couldn’t restore your unsaved edits')
    const actions = Array.from(card.querySelectorAll<HTMLButtonElement>(`[data-testid="${TESTID.cardAction}"]`))
    expect(actions.map((b) => b.dataset.action)).toEqual(['copy', 'dismiss'])
    act(() => actions[1]!.click())
    expect(session.calls.map((c) => c.method)).toContain('discardRecoveredDraft')
    expect(container.querySelector(`[data-testid="${TESTID.recoveredCard}"]`)).toBeNull()
  })

  it('a refused clipboard write says so instead of claiming a copy', async () => {
    const session = createFakeDocSession({ recovered: draft('merge-failed'), clipboard: { writeText: async () => Promise.reject(new Error('denied')) } })
    const { container } = render(<Harness session={session} />)
    const copy = container.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.cardAction}"][data-action="copy"]`)!
    act(() => copy.click())
    await waitFor(() => expect(copy.textContent).toBe('Copy failed'))
  })
})
