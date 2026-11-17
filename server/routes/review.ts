// server/routes/review.ts (P1). The one helper that turns the store's StoreReviewState into the wire ReviewState
// (CONTRACTS §3.9): presence and activity come from the handoff module, never from the store. GET /api/review, the
// `review` field of 409 errors and the SSE `hello` all go through it. While the day-0 handoff stub is mounted it
// reports { waiter: 'none' } and { state: 'idle' }.
import type { HandoffModule, ReviewState, StoreReviewState } from '../../shared/types'

export function withHandoff(handoff: Pick<HandoffModule<unknown>, 'presence' | 'activity'>): (r: StoreReviewState) => ReviewState {
  return (r) => ({ ...r, presence: handoff.presence(r.file), activity: handoff.activity(r.file) })
}
