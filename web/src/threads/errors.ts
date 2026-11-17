// web/src/threads/errors.ts (P3; QA round 3). What a failed write says in a card or a composer.
//
// A server that can't be reached rejects with the browser's own wording ("Failed to fetch" in Chrome, "Load failed" in
// Safari), which tells a colleague nothing. Say what happened, that the text is still in the box, and what to do about
// it. Any other failure keeps the reason the server gave.
/**
 * The session's network failure (a SessionError with `network` or code SERVER_UNREACHABLE, read duck-typed: the P3
 * boundary does not import P2's session), or the TypeError a bare fetch rejects with.
 */
export function isUnreachableError(e: unknown): boolean {
  if (e instanceof TypeError) return true
  if (typeof e !== 'object' || e === null) return false
  const o = e as { network?: unknown; code?: unknown }
  return o.network === true || o.code === 'SERVER_UNREACHABLE'
}

/** QA pass 4 #3: the server restarted with a new token; the old one is refused (the session also raises the Reload banner). */
export function isAuthLostError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'UNAUTHORIZED'
}
const LOST = 'This page lost its connection to the review. Reload to keep going.'

const TRY_AGAIN = 'Ask Claude to reopen the review, then try again.'

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong')

/** A comment or reply that could not be posted. */
export function postFailure(e: unknown, what: 'comment' | 'reply'): string {
  if (isAuthLostError(e)) return `${LOST} Your ${what} wasn’t posted; the text is still here.`
  return isUnreachableError(e)
    ? `Can’t reach the review server, so this ${what} wasn’t posted. Your text is still here. ${TRY_AGAIN}`
    : `Couldn’t post: ${reasonOf(e)}`
}

/** An edited comment that could not be saved. */
export function saveFailure(e: unknown): string {
  if (isAuthLostError(e)) return `${LOST} This change wasn’t saved; the text is still here.`
  return isUnreachableError(e)
    ? `Can’t reach the review server, so this change wasn’t saved. Your text is still here. ${TRY_AGAIN}`
    : `Couldn’t save: ${reasonOf(e)}`
}

/** Anything else a click does (resolve, reopen, delete): the reason alone, as the card prints it. */
export function opFailure(e: unknown): string {
  if (isAuthLostError(e)) return LOST
  return isUnreachableError(e) ? `Can’t reach the review server, so that didn’t go through. ${TRY_AGAIN}` : reasonOf(e)
}

/** A decision (accept, reject): `verb` completes "Couldn’t …". */
export function actionFailure(e: unknown, verb: string): string {
  if (isAuthLostError(e)) return LOST
  return isUnreachableError(e) ? opFailure(e) : `Couldn’t ${verb}: ${reasonOf(e)}`
}
