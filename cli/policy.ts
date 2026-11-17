// cli/policy.ts (P4). The suggest-only classifier (CONTRACTS §9.9.1, §4.4, D39). While a doc's policy.suggestOnly
// holds, every Claude op that writes .md bytes directly fails 403 SUGGEST_ONLY for the whole batch (the store enforces
// it); this mirrors the rule so the skill's third-party examples can be checked and the CLI can explain a refusal.
import type { AgentOp, BatchRequest } from '../shared/types'

/** Blocked under suggest-only: replace_block, replace_range, insert_after / insert_before, delete_block, write, decide accept. */
export function blockedBySuggestOnly(op: AgentOp): boolean {
  switch (op.op) {
    case 'replace_block':
    case 'replace_range':
    case 'insert_after':
    case 'insert_before':
    case 'delete_block':
    case 'write':
      return true
    case 'decide':
      return op.decision === 'accept'
    case 'comment':
    case 'reply':
    case 'suggest':
    case 'suggest_block':
    case 'resolve':
    case 'reopen':
    case 'edit_comment':
    case 'delete_comment':
    case 'withdraw':
      return false
  }
}

/** Index of the first op a suggest-only doc refuses, or null when the whole batch is allowed. */
export function firstBlockedOp(req: BatchRequest): number | null {
  const i = req.ops.findIndex(blockedBySuggestOnly)
  return i === -1 ? null : i
}
