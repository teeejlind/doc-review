// cli/direct.ts (P4). Direct mode: the server is down, so the CLI opens the doc store itself (CONTRACTS §9.3).
// Reads open readOnly (no lock, no writes, no recovery; needsRecovery reported instead); `pending` and writes open a
// direct store that takes the doc lock (LOCK_TIMEOUT_CLI_MS), reconciles, commits through the WAL and releases. A
// server started later adopts the write by hash as its own doc.rev { by: 'Claude' }, never as external.
import type { DocStore } from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { assertServable } from '../node/root'
import type { CliIo } from './io'
import type { Located } from './discover'

export async function withStore<T>(io: CliIo, at: Located, o: { readOnly?: boolean }, fn: (s: DocStore) => Promise<T>): Promise<T> {
  assertServable(at.root, at.abs)
  const store = await io.openDocStore(at.root, at.rel, {
    mode: 'direct', lockTimeoutMs: CONSTANTS.LOCK_TIMEOUT_CLI_MS, ...(o.readOnly ? { readOnly: true } : {}),
  })
  try {
    return await fn(store)
  } finally {
    await store.close().catch(() => {})
  }
}
