// node/reconcile.ts (P1). Own writes vs external writes, classified BY HASH (CONTRACTS §3.6, D5).
//
// reconcile() runs at the start of every locked transaction, on every watcher event for an opened doc, and on server
// start for every doc it opens. It never trusts an "own writes" set: only the ledger. With T = the last non-aborted
// doc.rev and h = sha256(disk):
//
// | file missing                                                            | 'missing'    (doc.missing once, SSE doc-removed) |
// | h === T.hash                                                            | 'in-sync'    (own echo, touch, a logged CLI write) |
// | T carries wal, no doc.abort follows, h === T.prevHash, and this process | 'not-landed' (doc.abort + server.recovered wal) |
// |   did not itself complete T's rename                                    |                                                  |
// | anything else                                                           | 'external'   (flush, object, doc.rev + doc.external) |
//
// A doc with no sidecar (rev 0) has no ledger to reconcile against: always 'in-sync'. The store applies the verdict
// (node/ledger.ts), because applying it appends to the log, writes objects and re-resolves anchors.
// The stable read (two equal reads WATCH_STABILITY_MS apart) is taken only when the first read disagrees with the
// ledger, so a reconcile that finds the doc in sync costs one read.
import type { Hash, SidecarEventOf } from '../shared/types'
import { readDisk, stableRead, type DiskRead } from './doc-io'

export type ReconcileVerdict =
  | { kind: 'in-sync'; disk: DiskRead }
  | { kind: 'missing'; disk: DiskRead; lastHash: Hash; alreadyRecorded: boolean }
  | { kind: 'not-landed'; disk: DiskRead; abortedRev: number }
  | { kind: 'external'; disk: DiskRead }

/** What reconcile needs from the fold: T and whether the doc is already recorded missing at T. */
export interface LedgerHead {
  /** The last non-aborted doc.rev (with its wal), or null when there is no sidecar / no rev yet. */
  T: SidecarEventOf<'doc.rev'> | null
  /** A doc.abort for T.rev appears after it. */
  tAborted: boolean
  /** A doc.missing was appended after T (so a second one is not). */
  missingRecorded: boolean
}

export function classify(head: LedgerHead, disk: DiskRead, renamedByMe: ReadonlySet<number>): ReconcileVerdict {
  const T = head.T
  if (!T) return { kind: 'in-sync', disk }
  if (!disk.exists) return { kind: 'missing', disk, lastHash: T.hash, alreadyRecorded: head.missingRecorded }
  if (disk.hash === T.hash) return { kind: 'in-sync', disk }
  if (T.wal && !head.tAborted && T.prevHash !== null && disk.hash === T.prevHash && !renamedByMe.has(T.rev)) {
    return { kind: 'not-landed', disk, abortedRev: T.rev }
  }
  return { kind: 'external', disk }
}

/** Read the disk and classify; a disagreement with the ledger is re-read until stable before it is acted on. */
export async function reconcileDisk(abs: string, head: LedgerHead, renamedByMe: ReadonlySet<number>): Promise<ReconcileVerdict> {
  const first = readDisk(abs)
  const v = classify(head, first, renamedByMe)
  if (v.kind === 'in-sync') return v
  if (v.kind === 'missing' && v.alreadyRecorded) return v
  return classify(head, await stableRead(abs), renamedByMe)
}
