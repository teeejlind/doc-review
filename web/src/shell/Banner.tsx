// web/src/shell/Banner.tsx (P3; CONTRACTS §12.14, §12.15, §13 rows 22, 26, 28–31, 61).
//
// The one banner the session says applies (`session.getBanner()`, precedence already applied by P2), with its
// copy and action. P3 never infers a banner from an error on its own.
import type { ReactNode } from 'react'
import { TESTID } from '../../../shared/constants'
import type { DocSession, SessionBanner } from '../../../shared/types'
import { agentCmd } from '../identity'

type BannerAction = 'recreate' | 'reload' | 'take-over' | 'dismiss'

const SIDECAR_CODES = new Set(['SIDECAR_CORRUPT', 'SIDECAR_SCHEMA_UNSUPPORTED'])
/** QA3: a file the editor can't show says how to make it showable, not just what is wrong. */
const FIX_HINT: Partial<Record<string, string>> = {
  NOT_UTF8: 'To read and edit it here, save it as UTF-8 text (or ask Claude to convert it), then reload.',
  TOO_LARGE: 'Split it into smaller files to edit it here.',
}

export function bannerContent(b: SessionBanner): { text: ReactNode; action?: { kind: BannerAction; label: string }; urgent: boolean } {
  switch (b.kind) {
    case 'doc-removed':
      return {
        text: 'This file was moved or deleted. Your copy is safe in this tab.',
        ...(b.canRecreate ? { action: { kind: 'recreate' as const, label: 'Recreate from my copy' } } : {}),
        urgent: true,
      }
    case 'review-reset':
      return { text: 'Review data for this file was reset. Earlier comments and suggestions are gone from this view.', action: { kind: 'dismiss', label: 'Dismiss' }, urgent: false }
    case 'connection-lost':
      return { text: 'This page lost its connection to the review. Reload to keep going. Anything you typed since the last save is kept in this browser and comes back after the reload.', action: { kind: 'reload', label: 'Reload' }, urgent: true }
    case 'contract-mismatch':
      return { text: 'This page is out of date.', action: { kind: 'reload', label: 'Reload' }, urgent: true }
    case 'read-only':
      return {
        text: SIDECAR_CODES.has(b.code) ? (
          <>
            {b.message} Ask Claude to run <code>{agentCmd()} doctor</code>.
          </>
        ) : FIX_HINT[b.code] ? (
          `${b.message}${/[.!?]$/.test(b.message) ? '' : '.'} ${FIX_HINT[b.code]}`
        ) : (
          b.message
        ),
        urgent: false,
      }
    case 'tab-not-leader':
      return {
        text: 'This document is open in another tab, so this tab is read-only. Switch to that tab, or take over to edit here.',
        action: { kind: 'take-over', label: 'Take over' },
        urgent: false,
      }
  }
}

export function runBannerAction(session: DocSession, kind: BannerAction): void {
  switch (kind) {
    case 'recreate':
      void session.recreate().catch(() => undefined) // a failure arrives as a RECREATE_FAILED notice (§12.14)
      return
    case 'reload':
      void session.reload()
      return
    case 'take-over':
      session.takeOver()
      return
    case 'dismiss':
      session.dismissBanner()
      return
  }
}

export function Banner({ banner, session }: { banner: SessionBanner; session: DocSession }) {
  const c = bannerContent(banner)
  return (
    <div className="mdr-banner" data-testid={TESTID.banner} data-kind={banner.kind} role={c.urgent ? 'alert' : 'status'}>
      <span className="mdr-banner-text">{c.text}</span>
      {c.action ? (
        <button
          type="button"
          className="mdr-button"
          data-testid={TESTID.bannerAction}
          data-action={c.action.kind}
          aria-label={c.action.label}
          onClick={() => runBannerAction(session, c.action!.kind)}
        >
          {c.action.label}
        </button>
      ) : null}
    </div>
  )
}
