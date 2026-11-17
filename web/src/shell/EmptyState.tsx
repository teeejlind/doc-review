// web/src/shell/EmptyState.tsx (P3; CONTRACTS §12.0.1, §12.0.2, §12.0.3).
//
// The page without a document: no ?file=, an invalid one (mdr-file-error), an openDocSession rejection with one of
// the empty-state codes, a page not opened from `mdr open` (readBootstrap threw), or a failure to start. Copy by
// reason is the contract's; `data-reason` carries the ErrorCode, or 'no-file' / 'no-bootstrap' / 'open-failed'.
import { useState, type ReactNode } from 'react'
import { TESTID } from '../../../shared/constants'
import { agentCmd } from '../identity'
import { ShellLayout } from './ShellLayout'

export const NO_FILE = 'no-file'
export const NO_BOOTSTRAP = 'no-bootstrap'
export const OPEN_FAILED = 'open-failed'
export const EDITOR_FAILED = 'editor-failed'

const code = (s: string): ReactNode => <code>{s}</code>

/**
 * §12.0.1 / §12.0.2 copy, written for a colleague who has never seen a terminal: what happened, then what to do (Ask
 * Claude ...). `file` is the requested ?file= value (may be empty).
 */
export function emptyCopy(reason: string, file: string): ReactNode {
  switch (reason) {
    case NO_FILE:
      return <>No document is open. Ask Claude to open one for review.</>
    case 'FILE_NOT_FOUND':
    case 'DOC_GONE':
      return <>We couldn't find {code(file)}. Ask Claude to reopen it.</>
    case 'PROTECTED_ROOT':
      return <>{code(file)} is in a protected folder, so it can't be reviewed here.</>
    case 'PATH_OUTSIDE_ROOT':
      return <>{code(file)} is outside the folder being reviewed. Ask Claude to open it from there.</>
    case 'BAD_REQUEST':
      return <>Only Markdown files (.md or .markdown) can be reviewed here.</>
    case NO_BOOTSTRAP:
      return <>This page has to be opened by Claude. Ask it to open a document for review.</>
    case EDITOR_FAILED:
      return <>The editor couldn't start.</>
    case OPEN_FAILED:
      return <>{code(file)} couldn't be opened.</>
    default:
      return file ? <>{code(file)} can't be opened here</> : <>This document can't be opened here</>
  }
}

/** The command that would reopen a missing file, for the Copy command button (null: nothing useful to copy). */
export function emptyCommand(reason: string, file: string): string | null {
  if ((reason !== 'FILE_NOT_FOUND' && reason !== 'DOC_GONE') || !file) return null
  return `${agentCmd()} open ${/\s/.test(file) ? JSON.stringify(file) : file}`
}

/** Reasons that offer a Reload button (the page itself is the problem, not the file). */
const RELOADABLE = new Set([NO_BOOTSTRAP, OPEN_FAILED, EDITOR_FAILED])

export interface EmptyStateProps {
  reason: string
  file: string
  /** A technical detail line under the copy (error message), optional. */
  detail?: string | null
  onReload?: () => void
}

export function EmptyState({ reason, file, detail, onReload }: EmptyStateProps) {
  const command = emptyCommand(reason, file)
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const copy = (): void => {
    if (command === null) return
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(
        () => setCopied('yes'),
        () => setCopied('failed'),
      )
  }
  const copyLabel = copied === 'yes' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy command'
  return (
    <section className="mdr-empty-state" data-testid={TESTID.emptyState} data-reason={reason} aria-live="polite">
      <p className="mdr-empty-state-text">{emptyCopy(reason, file)}</p>
      {detail ? <p className="mdr-empty-state-detail">{detail}</p> : null}
      {RELOADABLE.has(reason) && onReload ? (
        <button type="button" className="mdr-button mdr-button--primary" aria-label="Reload" onClick={onReload}>
          Reload
        </button>
      ) : null}
      {command !== null ? (
        <button type="button" className="mdr-button mdr-button--small mdr-button--quiet" aria-label={copyLabel} title={command} onClick={copy}>
          {copyLabel}
        </button>
      ) : null}
    </section>
  )
}

/** The whole page for an empty or error state: the §12.0.1 frame (host ids intact, the empty top bar hidden) with the message in the column. */
export function EmptyPage(props: EmptyStateProps) {
  return <ShellLayout bare docBefore={<EmptyState {...props} />} />
}
