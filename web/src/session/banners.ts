// web/src/session/banners.ts (P2). Safety states, banner precedence and the save-state machine (CONTRACTS §12.4,
// §12.14). Pure: the session keeps the flags and asks these functions what to expose.
//
// Precedence when several banners apply: connection-lost > contract-mismatch > doc-removed > read-only > tab-not-leader > review-reset.
// Only the highest shows. The same order decides which read-only code the save state reports.
import type { ErrorCode, IsoTime, ReadOnlyCode, SaveState, SessionBanner } from '../../../shared/types'

export type ReadOnlyBannerCode = Extract<SessionBanner, { kind: 'read-only' }>['code']
export const READ_ONLY_BANNER_CODES: ReadonlySet<ReadOnlyCode> = new Set<ReadOnlyCode>([
  'NOT_UTF8', 'TOO_LARGE', 'SIDECAR_CORRUPT', 'SIDECAR_SCHEMA_UNSUPPORTED',
])
export const isReadOnlyBannerCode = (c: ReadOnlyCode): c is ReadOnlyBannerCode => READ_ONLY_BANNER_CODES.has(c)

/** The one sentence for a page whose server restarted under it (banner, save-chip tooltip, failed-post toasts). */
export const CONNECTION_LOST_TEXT = 'This page lost its connection to the review. Reload to keep going.'

export interface SafetyFlags {
  /** The server answered 401 UNAUTHORIZED: it restarted with a new token, so nothing this page sends can succeed. */
  authLost: boolean
  contractMismatch: { expected: string; actual: string } | null
  docRemoved: { canRecreate: boolean } | null
  readOnly: { code: ReadOnlyBannerCode; message: string } | null
  tabNotLeader: boolean
  reviewReset: Extract<SessionBanner, { kind: 'review-reset' }> | null
}

export const NO_SAFETY_FLAGS: SafetyFlags = { authLost: false, contractMismatch: null, docRemoved: null, readOnly: null, tabNotLeader: false, reviewReset: null }

export function pickBanner(f: SafetyFlags): SessionBanner | null {
  if (f.authLost) return { kind: 'connection-lost' }
  if (f.contractMismatch) return { kind: 'contract-mismatch', expected: f.contractMismatch.expected, actual: f.contractMismatch.actual }
  if (f.docRemoved) return { kind: 'doc-removed', canRecreate: f.docRemoved.canRecreate }
  if (f.readOnly) return { kind: 'read-only', code: f.readOnly.code, message: f.readOnly.message }
  if (f.tabNotLeader) return { kind: 'tab-not-leader' }
  if (f.reviewReset) return f.reviewReset
  return null
}

/** The read-only reason that blocks saving, by the same precedence; null when the session may save. */
export function readOnlyReason(f: SafetyFlags, file: string): { code: ReadOnlyCode; message: string } | null {
  if (f.authLost) return { code: 'CONTRACT_MISMATCH', message: CONNECTION_LOST_TEXT }
  if (f.contractMismatch) return { code: 'CONTRACT_MISMATCH', message: 'This page is out of date. Reload to keep editing.' }
  if (f.docRemoved) return { code: 'DOC_GONE', message: `${file} was moved or deleted` }
  if (f.readOnly) return { code: f.readOnly.code, message: f.readOnly.message }
  if (f.tabNotLeader) return { code: 'TAB_NOT_LEADER', message: 'This file is open in another tab' }
  return null
}

export interface SaveFlags {
  readOnly: { code: ReadOnlyCode; message: string } | null
  /** A save request is on the wire. */
  saving: boolean
  offline: { since: IsoTime; retryAt: IsoTime } | null
  error: { code: ErrorCode; message: string } | null
  /** Held conflicts plus held unsaveable ops (§7.4). */
  held: number
  /** Doc-changing edits not yet persisted (inside the debounce, or waiting). */
  dirty: boolean
  /** The last adopted rev, and when it was confirmed. */
  rev: number
  savedAt: IsoTime
}

/**
 * §12.4: unsaved (dirty, inside the debounce) -> saving -> saved | offline | conflict | error | readonly.
 * readonly wins over everything; then a request on the wire; then offline; then error; then held conflicts.
 */
export function deriveSaveState(f: SaveFlags): SaveState {
  if (f.readOnly) return { state: 'readonly', code: f.readOnly.code, message: f.readOnly.message }
  if (f.saving) return { state: 'saving' }
  if (f.offline) return { state: 'offline', since: f.offline.since, retryAt: f.offline.retryAt }
  if (f.error) return { state: 'error', code: f.error.code, message: f.error.message }
  if (f.held > 0) return { state: 'conflict', count: f.held }
  if (f.dirty) return { state: 'unsaved' }
  return { state: 'saved', rev: f.rev, at: f.savedAt }
}

export function sameSaveState(a: SaveState, b: SaveState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function sameBanner(a: SessionBanner | null, b: SessionBanner | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
