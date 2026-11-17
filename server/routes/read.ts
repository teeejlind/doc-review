// server/routes/read.ts (P1). The read routes (CONTRACTS §2.5 M1, §8.3, §8.4, §8.6):
//   browser (actor TJ): GET /api/me (the human's display name, generalization pass), /api/doc, /api/review,
//                       /api/asset (an image beside the doc, ?t= token), /api/history, /api/history/version,
//                       /api/history/diff,
//                       /api/events (file channel: `hello`, then `resync` when afterSeq/knownRev are behind; root
//                       channel: registered, no hello)
//   agent (actor Claude): GET /api/agent/status, /snapshot, /thread, /pending, /history, /history/version,
//                       /history/diff — each returns exactly the CLI stdout JSON (§9); status and pending carry
//                       `user` (the display name, resolved per request so `mdr config set name` applies at once)
// The §8.1 middleware has already run (Host, actor, headers, token, origin). Every StoreError thrown here becomes
// the ApiError envelope in app.ts's onError, with `review` overlaid through withHandoff.
import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { Hono } from 'hono'
import type { BrowserSseEvent, ClientId, HistoryRef, MeResult, PendingResult, StatusResult, ThreadId, VersionId } from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import { StoreError, isStoreError } from '../../shared/errors'
import { isBlockRef, isThreadId, isVersionId } from '../../shared/ids'
import { MDR_VERSION } from '../../shared/version'
import { resolveDisplayName } from '../../node/identity'
import { validateAsset, type ServerEnv } from '../security'
import { fileOf, flagOf, natOf, resolveFile, type RouteCtx } from './context'

/** The largest image /api/asset sends. */
const MAX_ASSET_BYTES = 32 * 1024 * 1024
const HISTORY_REF_RE = /^(v[1-9][0-9]*|rev:(0|[1-9][0-9]*)|current)$/

function versionOf(v: string | undefined): VersionId {
  if (!v || !isVersionId(v)) throw new StoreError('BAD_REQUEST', '?v= must be a version id (vN)')
  return v
}

function refOf(name: string, v: string | undefined): HistoryRef {
  if (!v || !HISTORY_REF_RE.test(v)) throw new StoreError('BAD_REQUEST', `?${name}= must be vN, rev:N or current`)
  return v as HistoryRef
}

/** Long-lived streams never time out (§8.7): Node's per-socket timeout off for this request. */
function keepOpen(env: unknown): void {
  const incoming = (env as { incoming?: IncomingMessage } | undefined)?.incoming
  incoming?.socket?.setTimeout(0)
}

export function readRoutes(ctx: RouteCtx): { routes: Hono<ServerEnv>; close(): void } {
  const app = new Hono<ServerEnv>()

  // ------------------------------------------------------------------ browser

  app.get('/api/me', (c) => {
    const me: MeResult = { ok: true, ...resolveDisplayName() }
    return c.json(me)
  })

  // An image the markdown points at, relative to the doc (Pass 4 #28). Read-only, images only (validateAsset); the
  // page builds the URL with ?t= because an <img> can't send the token header.
  app.get('/api/asset', (c) => {
    const a = validateAsset(ctx.root, fileOf(c, ctx.root), c.req.query('path'))
    if (!a.ok) throw new StoreError(a.code, a.message)
    if (statSync(a.abs).size > MAX_ASSET_BYTES) throw new StoreError('PAYLOAD_TOO_LARGE', 'that image is too large to show')
    return c.body(readFileSync(a.abs), 200, {
      'Content-Type': a.type,
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
      // opened on its own, an SVG gets no scripts and no origin
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
  })

  app.get('/api/doc', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    return c.json(await store.snapshot())
  })

  app.get('/api/review', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    return c.json(ctx.withHandoff(await store.review()))
  })

  const historyList = async (file: string, limit: number | undefined) => (await ctx.store(file)).history.list(limit !== undefined ? { limit } : {})
  app.get('/api/history', async (c) => c.json(await historyList(fileOf(c, ctx.root), natOf(c, 'limit'))))
  app.get('/api/history/version', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    return c.json(await store.history.show(versionOf(c.req.query('v'))))
  })
  app.get('/api/history/diff', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    return c.json(await store.history.diff(refOf('from', c.req.query('from')), refOf('to', c.req.query('to'))))
  })

  // §8.6. The middleware checked ?t= and ?clientId= (and Origin when present).
  const beaconTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const cancelBeacon = (file: string): void => {
    const t = beaconTimers.get(file)
    if (t) clearTimeout(t)
    beaconTimers.delete(file)
  }
  app.get('/api/events', async (c) => {
    keepOpen(c.env)
    const clientId = c.req.query('clientId') as ClientId
    const rawFile = c.req.query('file')
    if (rawFile === undefined || rawFile === '') {
      return ctx.hub.open({ file: null, clientId }).response
    }
    // a recorded doc whose file is gone still gets a stream: `doc-removed` instead of `hello` (an EventSource gives up
    // for good on a non-200, so a 410 would leave a reconnecting tab knowing nothing), and a recreate reaches it later
    const file = resolveFile(ctx.root, rawFile, { allowGone: true, known: ctx.hasStore })
    const store = await ctx.store(file)
    let snap: Awaited<ReturnType<typeof store.snapshot>> | null = null
    try {
      snap = await store.snapshot()
    } catch (e) {
      if (!(isStoreError(e) && e.code === 'DOC_GONE')) throw e
    }
    const afterSeq = natOf(c, 'afterSeq')
    const knownRev = natOf(c, 'knownRev')
    cancelBeacon(file)
    const { response, client } = ctx.hub.open({
      file, clientId,
      onClose: () => {
        // the last stream for the file closing starts the BEACON_GRACE_MS flush timer; a reconnect cancels it (§7.1)
        if (ctx.hub.clients(file).length > 0) return
        cancelBeacon(file)
        const t = setTimeout(() => {
          beaconTimers.delete(file)
          if (ctx.hub.clients(file).length > 0) return
          void store.flushTjSession('beacon').catch(() => undefined)
        }, ctx.beaconGraceMs)
        ;(t as { unref?: () => void }).unref?.()
        beaconTimers.set(file, t)
      },
    })
    if (snap === null) {
      client.send('doc-removed', { file })
      return response
    }
    const h = ctx.health()
    const hello: Extract<BrowserSseEvent, { event: 'hello' }>['data'] = {
      serverId: h.serverId, protocol: h.protocol, version: MDR_VERSION, schemaFingerprint: h.schemaFingerprint, file,
      docId: snap.docId, rev: snap.rev, hash: snap.hash, seq: snap.seq,
      presence: ctx.handoff.presence(file), activity: ctx.handoff.activity(file),
    }
    const id = `${snap.rev}.${snap.seq}`
    client.send('hello', hello, id)
    if ((afterSeq !== undefined && snap.seq > afterSeq) || (knownRev !== undefined && snap.rev !== knownRev)) {
      client.send('resync', { reason: 'gap' }, id)
    }
    return response
  })

  // ------------------------------------------------------------------ agent

  app.get('/api/agent/status', async (c) => {
    const file = fileOf(c, ctx.root)
    const store = await ctx.store(file)
    const s = await store.agent.status()
    const h = ctx.health()
    const out: StatusResult = {
      ...s,
      server: { state: 'up', port: h.port, url: `http://${CONSTANTS.HOST}:${h.port}/`, pid: h.pid, version: h.version, protocol: h.protocol },
      presence: ctx.handoff.presence(file),
      activity: ctx.handoff.activity(file),
      user: resolveDisplayName(),
    }
    return c.json(out)
  })

  app.get('/api/agent/snapshot', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    const from = c.req.query('from')
    const to = c.req.query('to')
    for (const [name, v] of [['from', from], ['to', to]] as const) {
      if (v !== undefined && !isBlockRef(v)) throw new StoreError('BAD_REQUEST', `?${name}= must be a block ref (bN)`)
    }
    const md = flagOf(c, 'md')
    const text = flagOf(c, 'text')
    return c.json(await store.agent.snapshot({
      ...(md !== undefined ? { md } : {}), ...(text !== undefined ? { text } : {}),
      ...(from !== undefined ? { from: from as `b${number}` } : {}), ...(to !== undefined ? { to: to as `b${number}` } : {}),
    }))
  })

  app.get('/api/agent/thread', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    const id = c.req.query('id')
    if (!id || !isThreadId(id)) throw new StoreError('BAD_REQUEST', '?id= must be a thread id (t_…)')
    return c.json(await store.agent.thread(id as ThreadId))
  })

  app.get('/api/agent/pending', async (c) => {
    const file = fileOf(c, ctx.root)
    const store = await ctx.store(file)
    const out: PendingResult = { ...(await store.agent.pending()), user: resolveDisplayName() }
    ctx.handoff.pendingServed?.(file, out.empty)
    return c.json(out)
  })

  app.get('/api/agent/history', async (c) => c.json(await historyList(fileOf(c, ctx.root), natOf(c, 'limit'))))
  app.get('/api/agent/history/version', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    return c.json(await store.history.show(versionOf(c.req.query('v'))))
  })
  app.get('/api/agent/history/diff', async (c) => {
    const store = await ctx.store(fileOf(c, ctx.root))
    return c.json(await store.history.diff(refOf('from', c.req.query('from')), refOf('to', c.req.query('to'))))
  })

  return {
    routes: app,
    close: () => {
      for (const t of beaconTimers.values()) clearTimeout(t)
      beaconTimers.clear()
    },
  }
}
