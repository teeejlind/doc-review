// server/routes/test-hooks.ts (P1). Test-only routes, mounted ONLY when the server runs with MDR_TEST_HOOKS=1 (e2e;
// CONTRACTS §2.5, §8.1 item 10, D51). A production server never mounts them.
//   POST /__test/splice-fault { file?, blockHashes } → { ok, blockHashes }: until cleared with [], applyBlockOps treats
//   every op covering one of those base block hashes as failing every widening level (setSpliceFaultForTests, §3.4),
//   so a save holds that op as `unsaveable` and an accept or CLI edit refuses. Block hashes are content hashes, so the
//   fault is process-wide like fakeApp's; `file`, when given, is validated like any other.
// The §8.1 middleware treats /__test/* as a browser route: token, X-MDR-Client: web, an allowed Origin and
// X-MDR-Client-Id are required.
import { Hono } from 'hono'
import type { BlockHash } from '../../shared/types'
import { StoreError } from '../../shared/errors'
import { setSpliceFaultForTests } from '../../core/splice/apply'
import type { ServerEnv } from '../security'
import { bodyOf, resolveFile, type RouteCtx } from './context'

export function testHookRoutes(ctx: RouteCtx): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>()
  app.post('/__test/splice-fault', (c) => {
    const b = (bodyOf(c) ?? {}) as { file?: unknown; blockHashes?: unknown }
    const raw = c.req.query('file') ?? (typeof b.file === 'string' ? b.file : undefined)
    if (raw !== undefined) resolveFile(ctx.root, raw, { known: (f) => ctx.hasStore(f) })
    if (!Array.isArray(b.blockHashes) || !b.blockHashes.every((h) => typeof h === 'string')) {
      throw new StoreError('BAD_REQUEST', 'blockHashes must be an array of block hashes')
    }
    const set = new Set(b.blockHashes as BlockHash[])
    setSpliceFaultForTests(set.size ? (op) => op.covers.some((h) => set.has(h)) : null)
    return c.json({ ok: true as const, blockHashes: [...set] })
  })
  return app
}
