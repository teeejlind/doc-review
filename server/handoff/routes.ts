// server/handoff/routes.ts (P4). HTTP surface of the handoff module (CONTRACTS §8.3 POST /api/handoff, §8.4 consume /
// disarm / arm / wait, §8.7). P1's server/app.ts mounts these behind its §8.1 middleware (Host, actor, headers, token,
// identity-in-body); fakeApp mounts its own stub the same way.
//
// Errors are thrown as StoreError; the host app's onError maps them to ApiError (overlaying presence and activity).
// `file`: the host's validated value when its middleware stored one on the context (fakeApp does), else ?file= or the
// body's "file", validated here with node/root.ts (POSIX-relative, inside the root by realpath, .md/.markdown, not
// protected, existing; §8.1 step 7).
import { existsSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { Hono, type Context } from 'hono'
import type { ArmRouteResult, DisarmResult, HandoffRequest, WaiterId } from '../../shared/types'
import { StoreError } from '../../shared/errors'
import { isWaiterId } from '../../shared/ids'
import { HandoffRequestSchema } from '../../shared/schemas'
import { assertServable, isInside, realId } from '../../node/root'
import type { HandoffCore } from './index'

const vars = (c: Context): { get(k: string): unknown } => c as unknown as { get(k: string): unknown }

/** posix.normalize + NFC, no leading './': the key every per-doc map in the module uses. */
export function normFile(raw: string): string {
  const n = posix.normalize(raw.normalize('NFC'))
  return n.startsWith('./') ? n.slice(2) : n
}

/** §8.1 step 7 for a root-relative file (used when the host middleware did not validate it). */
export function validateFile(root: string, raw: string | undefined): string {
  if (raw === undefined || raw === '') throw new StoreError('BAD_REQUEST', 'missing file')
  if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new StoreError('PATH_OUTSIDE_ROOT', `${raw} must be a POSIX path relative to the served root`)
  }
  const file = normFile(raw)
  if (file === '..' || file.startsWith('../')) throw new StoreError('PATH_OUTSIDE_ROOT', `${raw} is outside the served root`)
  if (!/\.(md|markdown)$/i.test(file)) throw new StoreError('BAD_REQUEST', 'only .md and .markdown files are served')
  const lexical = join(root, ...file.split('/'))
  assertServable(root, lexical)
  if (!existsSync(lexical)) throw new StoreError('FILE_NOT_FOUND', `${file} does not exist`)
  const abs = realId(lexical)
  if (!isInside(root, abs)) throw new StoreError('PATH_OUTSIDE_ROOT', `${file} resolves outside the served root`)
  if (!statSync(abs).isFile()) throw new StoreError('FILE_NOT_FOUND', `${file} is not a file`)
  assertServable(root, abs)
  return file
}

async function bodyOf(c: Context): Promise<unknown> {
  const pre = vars(c).get('body')
  if (pre !== undefined) return pre
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

async function fileOf(c: Context, root: string, body: unknown): Promise<string> {
  const pre = vars(c).get('file')
  if (typeof pre === 'string' && pre !== '') return normFile(pre)
  let raw = c.req.query('file')
  if ((raw === undefined || raw === '') && body && typeof body === 'object' && typeof (body as { file?: unknown }).file === 'string') {
    raw = (body as { file: string }).file
  }
  return validateFile(root, raw)
}

function clientIdOf(c: Context): `k_${string}` | undefined {
  const pre = vars(c).get('clientId')
  if (typeof pre === 'string') return pre as `k_${string}`
  const h = c.req.header('x-mdr-client-id')
  return h && /^k_[0-9A-HJKMNP-TV-Z]{26}$/.test(h) ? (h as `k_${string}`) : undefined
}

export function handoffRoutes(core: HandoffCore): Hono {
  const routes = new Hono()
  const root = core.deps.root

  // POST /api/handoff (browser, actor TJ): §8.5 steps 1–6
  routes.post('/api/handoff', async (c) => {
    const body = await bodyOf(c)
    const file = await fileOf(c, root, body)
    const parsed = HandoffRequestSchema.safeParse(body)
    if (!parsed.success) {
      const i = parsed.error.issues[0]
      throw new StoreError('BAD_REQUEST', `invalid HandoffRequest: ${i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'schema mismatch'}`)
    }
    const clientId = clientIdOf(c)
    return c.json(await core.handoff(file, parsed.data as HandoffRequest, clientId ? { clientId } : {}))
  })

  // GET /api/agent/wait?file=&waiter=&gen= (Claude): the waiter stream, §8.7
  routes.get('/api/agent/wait', async (c) => {
    const file = await fileOf(c, root, undefined)
    const w = c.req.query('waiter') ?? ''
    if (!isWaiterId(w)) throw new StoreError('BAD_REQUEST', '?waiter= must be w_ + 16 hex')
    const genRaw = c.req.query('gen')
    const gen = genRaw === undefined || genRaw === '' ? Date.now() : Number(genRaw)
    if (!Number.isFinite(gen)) throw new StoreError('BAD_REQUEST', '?gen= must be a number')
    // long-lived stream: no socket timeout (the server also sets requestTimeout = 0, §8.7)
    try {
      ;(c.env as { incoming?: { socket?: { setTimeout(ms: number): void } } } | undefined)?.incoming?.socket?.setTimeout(0)
    } catch {
      // not on @hono/node-server
    }
    const stream = await core.openWaiter(file, w as WaiterId, gen)
    return c.body(stream, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
  })

  // POST /api/agent/handoff/consume { file, handoffs, waiter } (Claude): idempotent
  routes.post('/api/agent/handoff/consume', async (c) => {
    const body = (await bodyOf(c)) as { handoffs?: unknown; waiter?: unknown } | undefined
    const file = await fileOf(c, root, body)
    if (!body || !Array.isArray(body.handoffs) || !body.handoffs.every((x) => Number.isInteger(x) && (x as number) > 0)) {
      throw new StoreError('BAD_REQUEST', 'handoffs must be an array of handoff seqs')
    }
    const waiter = typeof body.waiter === 'string' && isWaiterId(body.waiter) ? body.waiter : undefined
    if (body.waiter !== undefined && waiter === undefined) throw new StoreError('BAD_REQUEST', 'waiter must be w_ + 16 hex')
    return c.json(await core.consume(file, body.handoffs as number[], waiter))
  })

  // POST /api/agent/disarm { file } (Claude): end of review
  routes.post('/api/agent/disarm', async (c) => {
    const body = await bodyOf(c)
    const file = await fileOf(c, root, body)
    const out: DisarmResult = await core.disarm(file)
    return c.json(out)
  })

  // POST /api/agent/arm { file } (Claude): a loop is starting; turn / none → grace (D48)
  routes.post('/api/agent/arm', async (c) => {
    const body = await bodyOf(c)
    const file = await fileOf(c, root, body)
    const out: ArmRouteResult = core.arm(file)
    return c.json(out)
  })

  return routes
}
