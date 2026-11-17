// tests/unit/web/shell/save-chip.test.tsx (P3; CONTRACTS §12.4 save-state labels and Retry, §12.15 saveChip).
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import type { ReadOnlyCode, SaveState } from '../../../../shared/types'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { READ_ONLY_REASON, SaveChip, saveChipView } from '../../../../web/src/shell/SaveChip'

afterEach(cleanup)

const at = '2026-10-15T12:00:00.000Z'
const chip = (): HTMLElement => document.querySelector(`[data-testid="${TESTID.saveChip}"]`) as HTMLElement

describe('saveChipView: §12.4 labels', () => {
  const cases: Array<[SaveState, string, 'retry' | 'conflict' | null]> = [
    [{ state: 'saved', rev: 4, at }, 'Saved', null],
    [{ state: 'unsaved' }, 'Saving…', null],
    [{ state: 'saving' }, 'Saving…', null],
    [{ state: 'offline', since: at, retryAt: at }, 'Offline: changes kept on this device', 'retry'],
    [{ state: 'conflict', count: 2 }, 'Conflict (2)', 'conflict'],
    [{ state: 'error', code: 'BAD_REQUEST', message: 'The request was malformed.' }, 'Couldn’t save: Retry', 'retry'],
    [{ state: 'error', code: 'IO_ERROR', message: "The server can't write this file." }, 'Couldn’t save: server can’t write this file', 'retry'],
    [{ state: 'readonly', code: 'TAB_NOT_LEADER', message: 'Open in another tab' }, 'Read-only: open in another tab', null],
  ]
  it.each(cases)('%o → %s', (s, label, action) => {
    const v = saveChipView(s)
    expect(v.label).toBe(label)
    expect(v.action).toBe(action)
  })

  it('the error state shows its code; the routine states announce nothing', () => {
    expect(saveChipView({ state: 'error', code: 'PAYLOAD_TOO_LARGE', message: 'Too big' }).code).toBe('PAYLOAD_TOO_LARGE')
    expect(saveChipView({ state: 'saved', rev: 1, at }).announce).toBeNull()
    expect(saveChipView({ state: 'saving' }).announce).toBeNull()
    expect(saveChipView({ state: 'offline', since: at, retryAt: at }).announce).toBe('Offline: changes kept on this device')
  })

  it('every read-only code has a reason', () => {
    const codes: ReadOnlyCode[] = ['NOT_UTF8', 'TOO_LARGE', 'SIDECAR_CORRUPT', 'SIDECAR_SCHEMA_UNSUPPORTED', 'CONTRACT_MISMATCH', 'DOC_GONE', 'TAB_NOT_LEADER']
    for (const code of codes) {
      expect(READ_ONLY_REASON[code]).toBeTruthy()
      expect(saveChipView({ state: 'readonly', code, message: 'm' }).label).toBe(`Read-only: ${READ_ONLY_REASON[code]}`)
    }
  })
})

describe('<SaveChip>', () => {
  it('follows the session’s save state; data-state mirrors SaveState.state', () => {
    const session = createFakeDocSession({ saveState: { state: 'saved', rev: 1, at } })
    render(<SaveChip session={session} />)
    expect(chip().dataset.state).toBe('saved')
    expect(chip().tagName).toBe('SPAN')
    act(() => session.emit({ save: { state: 'saving' } }))
    expect(chip().dataset.state).toBe('saving')
    expect(chip().textContent).toBe('Saving…')
  })

  it('"Couldn’t save: Retry" and the Offline label call session.retrySave()', () => {
    const session = createFakeDocSession({ saveState: { state: 'error', code: 'BAD_REQUEST', message: 'Malformed' } })
    render(<SaveChip session={session} />)
    expect(chip().tagName).toBe('BUTTON')
    expect(chip().textContent).toContain('Couldn’t save: Retry')
    expect(chip().textContent).toContain('BAD_REQUEST')
    act(() => chip().click())
    act(() => session.emit({ save: { state: 'offline', since: at, retryAt: at } }))
    expect(chip().textContent).toContain('Offline: changes kept on this device')
    act(() => chip().click())
    expect(session.calls.filter((c) => c.method === 'retrySave')).toHaveLength(2)
  })

  it('"Conflict (n)" asks for the first conflict card; the live region speaks it', () => {
    const onConflict = vi.fn()
    const session = createFakeDocSession({ saveState: { state: 'conflict', count: 1 } })
    const { container } = render(<SaveChip session={session} onConflict={onConflict} />)
    expect(chip().textContent).toContain('Conflict (1)')
    act(() => chip().click())
    expect(onConflict).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe('Conflict: 1 block needs a decision')
  })
})

describe('Cmd+S (QA round 1: unverified 59)', () => {
  it('is handled: the browser\'s Save Page dialog is suppressed and the pending edits are flushed now', () => {
    const session = createFakeDocSession({ file: 'doc.md', markdown: 'x\n' })
    render(<SaveChip session={session} onConflict={() => undefined} />)
    const e = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true })
    act(() => void window.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(true)
    expect(session.calls.some((c) => c.method === 'flush')).toBe(true)
    // Shift or Alt makes it a different shortcut
    const other = new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
    act(() => void window.dispatchEvent(other))
    expect(other.defaultPrevented).toBe(false)
  })
})
