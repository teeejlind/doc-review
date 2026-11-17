// core/suggest/settled.ts. Where a decided suggestion thread sits once the decision replaced the text it quoted.
//
// An accepted suggestion splices its proposed text over the text the thread's anchor quotes, so the anchor stops
// resolving and the thread would read as detached, as if its text had been deleted (QA3 R1, unverified 32 again). It
// is closed, not orphaned: place it at what replaced the quote instead. Pure; the store hands in the loaded doc.
import type { Resolution } from '../../shared/types'
import { decidedSuggestions, type FoldState, type ThreadFold } from '../sidecar/fold'
import type { Loaded } from '../splice/load'
import { locate } from './record'

/** The resolution of an accepted suggestion thread, or null when the thread is not one (callers keep their own). */
export function settledResolution(L: Pick<Loaded, 'src' | 'blocks'>, f: FoldState, t: ThreadFold): Resolution | null {
  if (t.detached) return null
  const ss = decidedSuggestions(f, t)
  if (!ss) return null
  const accepted = ss.filter((s) => s.status === 'accepted')
  if (!accepted.length) return null
  const s = accepted.reduce((a, b) => ((b.decidedSeq ?? b.updatedSeq) > (a.decidedSeq ?? a.updatedSeq) ? b : a))
  // the proposed text now sits where the base did; found again, the thread is placed exactly there
  const at = s.proposed === '' ? null : locate(L, { base: s.proposed, range: s.range })
  if (at) return { state: 'moved', block: at.start }
  // edited since, or a deletion: the block it was in is the best place left (the editor's rule for the same case)
  const i = Math.min(s.range.start, L.blocks.length - 1)
  return i >= 0 ? { state: 'fuzzy', block: i } : null
}
