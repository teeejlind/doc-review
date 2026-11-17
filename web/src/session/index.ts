// web/src/session/index.ts (P2): the session entry module (CONTRACTS §12.0.2, §12.0.3, §12.0.5). P3's main.tsx imports
// exactly these three exports from P2's session (§2.3); everything else under web/src/session is P2-private.
import type { ConnectRootChannel, OpenDocSession, ReadBootstrap } from '../../../shared/types'
import { readBootstrap as readBootstrapImpl } from './bootstrap'
import { connectRootChannel as connectRootChannelImpl } from './rootChannel'
import { openSession } from './session'

/** §12.0.2: reads the <meta name="mdr-*"> tags. Throws when mdr-token or mdr-root is missing. */
export const readBootstrap: ReadBootstrap = readBootstrapImpl

/**
 * §12.0.3: fetches snapshot + review, opens SSE, runs tab election. Rejects with a SessionError carrying `code`
 * (FILE_NOT_FOUND, DOC_GONE, PROTECTED_ROOT, PATH_OUTSIDE_ROOT, ...) when the document can't be opened.
 */
export const openDocSession: OpenDocSession = (o) => openSession(o)

/** §12.0.1: the root SSE channel of an empty-state tab (navigate only). */
export const connectRootChannel: ConnectRootChannel = connectRootChannelImpl
