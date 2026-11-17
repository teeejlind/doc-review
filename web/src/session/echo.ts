// web/src/session/echo.ts (P2). Echo suppression for the browser SSE stream (CONTRACTS §8.6, D32).
//
// Either rule suffices:
//   1. the event carries this tab's own clientId: the session already applied the result from the HTTP response;
//   2. hash / seq dedupe: a doc-changed whose hash equals the current Loaded's hash (the content is already there),
//      or a sidecar-changed whose seq is at or below the held review state's seq (it already folds it).
// Neither rule can skip a foreign change: a foreign doc change has a different hash, and a foreign sidecar change has a
// seq above any review state fetched before it. That is why the session never bumps review.seq from a write response
// without refetching (it would let rule 2 swallow a foreign event that raced the response).
import type { ClientId, Hash } from '../../../shared/types'

export type EchoVerdict = 'own-client' | 'same-hash' | 'seen-seq' | null

export function docChangedEcho(d: { clientId?: ClientId; hash: Hash }, s: { clientId: ClientId; loadedHash: Hash | null }): EchoVerdict {
  if (d.clientId !== undefined && d.clientId === s.clientId) return 'own-client'
  if (s.loadedHash !== null && d.hash === s.loadedHash) return 'same-hash'
  return null
}

export function sidecarChangedEcho(d: { clientId?: ClientId; seq: number }, s: { clientId: ClientId; reviewSeq: number }): EchoVerdict {
  if (d.clientId !== undefined && d.clientId === s.clientId) return 'own-client'
  if (d.seq <= s.reviewSeq) return 'seen-seq'
  return null
}
