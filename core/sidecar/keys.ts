// core/sidecar/keys.ts (P1). Idempotency keys (CONTRACTS §4.7). The ONLY CLI-key derivation in the codebase: the
// store calls cliKey inside DocStore.agent.batch under the lock; the CLI never derives a key.
//
// | Browser discrete action | 'tj:' + opKey                                                                 |
// | Browser save            | 'save:' + clientId + ':' + saveId (every line of the save batch)              |
// | CLI op                  | op.key ?? 'cli:' + sha256hex(relFile + '\0' + roundSeq + '\0' + canonicalJSON(opWithoutKey)).slice(0, 32) |
// roundSeq = seq of the latest non-void handoff.sent in the fold at batch time (0 if none; roundSeqOf). canonicalJSON
// sorts keys and drops undefined values.
import type { AgentOp, ClientId, OpKey } from '../../shared/types'
import { sha256Hex } from '../hash'
import type { FoldState } from './fold'

/** §4.7 roundSeq: the seq of the latest non-void handoff.sent in the fold (0 if none). */
export function roundSeqOf(f: Pick<FoldState, 'handoffs'>): number {
  let max = 0
  for (const seq of f.handoffs.keys()) if (seq > max) max = seq
  return max
}

/** JSON with object keys sorted at every depth and undefined values dropped. */
export function canonicalJSON(v: unknown): string {
  const canon = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map((e) => (e === undefined ? null : canon(e)))
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = canon(o[k])
      return out
    }
    return x
  }
  return JSON.stringify(canon(v))
}

/** The key of a CLI op: op.key when given, else the derived 'cli:' key. */
export function cliKey(relFile: string, roundSeq: number, op: AgentOp): string {
  if (op.key !== undefined) return op.key
  const { key: _key, ...rest } = op
  return 'cli:' + sha256Hex(relFile + '\0' + String(roundSeq) + '\0' + canonicalJSON(rest)).slice(0, 32)
}

export function tjKey(opKey: OpKey): string {
  return 'tj:' + opKey
}

export function saveKey(clientId: ClientId, saveId: number): string {
  return 'save:' + clientId + ':' + String(saveId)
}
