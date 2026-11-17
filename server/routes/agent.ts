// server/routes/agent.ts (P1). The agent write and control routes (actor Claude; CONTRACTS §8.4, §9.5, §9.9.1):
//   POST /api/agent/batch?file=   BatchRequest → BatchResult (the store computes the keys, resolves selectors
//                                 against the base map, enforces SUGGEST_ONLY; exactly the CLI stdout JSON)
//   POST /api/agent/open          { file } → { ok, connectedTabs, navigated }: a tab already on `file` → navigated, nothing
//                                 sent; else `navigate { file }` to the most recently active empty-state (root channel)
//                                 tab; else navigated false. A tab on another doc is never navigated (QA3)
//   POST /api/agent/policy        { file, suggestOnly } → { ok, seq, suggestOnly } (policy.set { by: 'Claude' } only on
//                                 a change)
//   POST /api/agent/shutdown      { root, reason: 'stop' | 'restart' } → { ok: true }, then RunningServer.close(reason);
//                                 ROOT_MISMATCH unless `root` is the served root
// (wait, arm, disarm and handoff/consume are the handoff module's, P4.) There is no agent route for restore (D11).
// Agent bodies may name the doc in `file` (§8.1 step 7); `?file=` wins when both are given.
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { BatchRequest, PolicyRequest } from '../../shared/types'
import * as S from '../../shared/schemas'
import { StoreError } from '../../shared/errors'
import { realId } from '../../node/root'
import type { ServerEnv } from '../security'
import { bodyOf, parseBody, resolveFile, type RouteCtx } from './context'

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The body without its `file` (agent bodies may carry it, the request schemas don't). */
function withoutFile(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !('file' in v)) return v
  const { file: _file, ...rest } = v as Record<string, unknown>
  return rest
}

export function agentRoutes(ctx: RouteCtx): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>()
  const known = (file: string): boolean => ctx.hasStore(file)
  const fileOf = (query: string | undefined, body: unknown): string => {
    const b = asObject(body).file
    return resolveFile(ctx.root, query ?? (typeof b === 'string' ? b : undefined), { known })
  }

  app.post('/api/agent/batch', async (c) => {
    const f = fileOf(c.req.query('file'), bodyOf(c))
    const req = parseBody<BatchRequest>(S.BatchRequestSchema, withoutFile(bodyOf(c)), 'BatchRequest')
    return c.json(await (await ctx.store(f)).agent.batch(req))
  })

  app.post('/api/agent/open', async (c) => {
    const f = fileOf(c.req.query('file'), bodyOf(c))
    const clients = ctx.hub.clients()
    const connectedTabs = clients.length
    // A tab on another doc may be a review in another chat (one root, several chats), so it is never navigated (QA3).
    // `clients()` is most recently active first: a tab already on `f` needs nothing; else the idle one (an empty-state
    // tab on the root channel) takes the doc; else nothing moves and the printed url is how the human gets there.
    if (clients.some((cl) => cl.file === f)) return c.json({ ok: true as const, connectedTabs, navigated: true })
    const idle = clients.find((cl) => cl.file === null)
    if (!idle) return c.json({ ok: true as const, connectedTabs, navigated: false })
    idle.send('navigate', { file: f })
    return c.json({ ok: true as const, connectedTabs, navigated: true })
  })

  app.post('/api/agent/policy', async (c) => {
    const f = fileOf(c.req.query('file'), bodyOf(c))
    const req = parseBody<PolicyRequest>(S.PolicyRequestSchema, withoutFile(bodyOf(c)), 'policy request')
    return c.json(await (await ctx.store(f)).agent.setPolicy(req))
  })

  app.post('/api/agent/shutdown', (c) => {
    const b = asObject(bodyOf(c))
    if (typeof b.root !== 'string') throw new StoreError('BAD_REQUEST', 'shutdown needs { root, reason }')
    const same = b.root === ctx.root || (existsSync(b.root) && realId(b.root) === ctx.root)
    if (!same) throw new StoreError('ROOT_MISMATCH', `shutdown refused: ${b.root} is not the served root ${ctx.root}`)
    if (b.reason !== undefined && b.reason !== 'stop' && b.reason !== 'restart') throw new StoreError('BAD_REQUEST', "reason must be 'stop' or 'restart'")
    ctx.shutdown(b.reason === 'restart' ? 'restart' : 'stop')
    return c.json({ ok: true as const })
  })

  return app
}
