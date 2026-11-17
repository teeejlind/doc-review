// tests/helpers/webClient.ts (integrator, day 0; CONTRACTS §2.5, §8.1, §8.3, §8.6, D32, D34).
//
// The headless TJ: exactly the browser routes, headers and SSE stream, with no ProseMirror. P1 and P4 e2e specs act as
// TJ through it, against the real server or startFakeServer. Every non-GET request carries X-MDR-Client: web,
// Authorization (token from <root>/.review/server.json), the server's own Origin and this client's X-MDR-Client-Id.
// `saveText` builds BlockOps with diffBlocks over load() of the current and next text, slicing `blocks` from `next`,
// and computes expectHash with applyBlockOps + docHash (doc-hash domain, BOM included, D40). Core is imported lazily
// after the jsdom globals are installed, so specs that never save don't boot Milkdown.
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ulid } from 'ulid'
import type {
  Anchor, BlockOp, BrowserSseEvent, ClientId, CreateThreadResponse, DecisionResult, DocSnapshot, HandoffRequest,
  HandoffResult, MessageResponse, OpKey, PolicyRequest, ReadMarkerRequest, ReviewState, SaveRequest, SaveResponse,
  SeqResponse, ServerMarker, SuggestionId, ThreadId, ThreadOpResponse, ApiError,
} from '../../shared/types'
import { readSse } from './sse'

export interface WebClient {
  readonly clientId: ClientId
  doc(): Promise<DocSnapshot>
  review(): Promise<ReviewState>
  /** Builds ops with diffBlocks over load() of the current and next text, slicing `blocks` from `next`; no ProseMirror. */
  saveText(next: string, o?: { allowPartial?: boolean; cause?: SaveRequest['cause'] }): Promise<SaveResponse>
  save(req: Omit<SaveRequest, 'clientId' | 'saveId'>): Promise<SaveResponse>
  createThread(anchor: Anchor, body: string): Promise<CreateThreadResponse>
  reply(thread: ThreadId, body: string): Promise<MessageResponse>
  resolve(thread: ThreadId): Promise<ThreadOpResponse>
  decide(id: SuggestionId, d: 'accept' | 'reject'): Promise<DecisionResult>
  handoff(message?: string, clientDecision?: HandoffRequest['clientDecision']): Promise<HandoffResult>
  setPolicy(p: PolicyRequest): Promise<SeqResponse>
  readMarker(req: ReadMarkerRequest): Promise<SeqResponse>
  events(o?: { afterSeq?: number; knownRev?: number }): AsyncIterable<BrowserSseEvent>
  /** Escape hatch for security tests: no default headers added. */
  raw(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }): Promise<Response>
  close(): Promise<void>
}

/** A non-2xx answer from a typed WebClient method: the parsed ApiError body and the HTTP status. */
export class WebClientError extends Error {
  readonly status: number
  readonly body: ApiError | unknown
  constructor(method: string, path: string, status: number, body: unknown) {
    const code = (body as ApiError | undefined)?.error?.code
    super(`${method} ${path} -> ${status}${code ? ` ${code}` : ''}: ${JSON.stringify(body).slice(0, 400)}`)
    this.name = 'WebClientError'
    this.status = status
    this.body = body
  }
  get code(): string | undefined {
    return (this.body as ApiError | undefined)?.error?.code
  }
}

export const newOpKey = (): OpKey => `op_${ulid()}`
export const newClientId = (): ClientId => `k_${ulid()}`

function readToken(root: string): string {
  const marker = JSON.parse(readFileSync(join(root, '.review', 'server.json'), 'utf8')) as ServerMarker
  return marker.token
}

// ---------------------------------------------------------------- lazy core (jsdom first, then Milkdown)

type CoreMod = {
  md: import('../../core/md/index').Md
  load: typeof import('../../core/splice/load').load
  applyBlockOps: typeof import('../../core/splice/apply').applyBlockOps
  diffBlocks: typeof import('../../core/blocks').diffBlocks
  docHash: typeof import('../../core/hash').docHash
}
let corePromise: Promise<CoreMod> | null = null
/** Headless core for the test process (one Md per process). */
export function testCore(): Promise<CoreMod> {
  corePromise ??= (async () => {
    const { installDom } = await import('../../core/md/dom-env.node.js') // `.js`: see tests/helpers/setup-node-dom.ts
    installDom()
    const [{ createMd }, { load }, { applyBlockOps }, { diffBlocks }, { docHash }] = await Promise.all([
      import('../../core/md/index'), import('../../core/splice/load'), import('../../core/splice/apply'),
      import('../../core/blocks'), import('../../core/hash'),
    ])
    return { md: await createMd(), load, applyBlockOps, diffBlocks, docHash }
  })()
  return corePromise
}

/**
 * The BlockOps that turn `current` into `next` (base = load(current)): one op per non-equal diffBlocks run, each new
 * block's source sliced from `next`. Exported for specs that want the ops without sending them.
 */
export async function opsForText(current: string, next: string): Promise<{ ops: BlockOp[]; blockHashes: string[]; text: string; failed: number[] }> {
  const c = await testCore()
  const L = c.load(c.md, current)
  const N = c.load(c.md, next)
  const ops: BlockOp[] = []
  for (const d of c.diffBlocks(L.blocks, N.blocks)) {
    if (d.op === 'equal') continue
    ops.push({
      after: d.a - 1,
      before: d.a + d.an,
      covers: L.blocks.slice(d.a, d.a + d.an).map((b) => b.hash),
      blocks: N.blocks.slice(d.b, d.b + d.bn).map((b) => next.slice(b.start, b.end)),
    })
  }
  const r = c.applyBlockOps(c.md, L, ops)
  return { ops, blockHashes: L.blocks.map((b) => b.hash), text: r.text, failed: r.failed }
}

// ---------------------------------------------------------------- client

export async function webClient(o: { port: number; root: string; file: string; host?: '127.0.0.1' | 'localhost'; token?: string }): Promise<WebClient> {
  const token = o.token ?? readToken(o.root)
  const host = o.host ?? '127.0.0.1'
  const origin = `http://${host}:${o.port}`
  const clientId = newClientId()
  const fileQ = `file=${encodeURIComponent(o.file)}`
  let saveId = 0
  const streams = new Set<AbortController>()

  const headers = (nonGet: boolean): Record<string, string> => {
    const h: Record<string, string> = { 'X-MDR-Client': 'web', Authorization: `Bearer ${token}`, Origin: origin }
    if (nonGet) {
      h['X-MDR-Client-Id'] = clientId
      h['Content-Type'] = 'application/json'
    }
    return h
  }

  async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const r = await fetch(origin + path, {
      method,
      headers: headers(method !== 'GET'),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await r.text()
    let json: unknown
    try {
      json = text === '' ? undefined : JSON.parse(text)
    } catch {
      json = text
    }
    if (!r.ok) throw new WebClientError(method, path, r.status, json)
    return json as T
  }

  const client: WebClient = {
    clientId,
    doc: () => call<DocSnapshot>('GET', `/api/doc?${fileQ}`),
    review: () => call<ReviewState>('GET', `/api/review?${fileQ}`),

    async saveText(next, so = {}) {
      const snap = await client.doc()
      const { ops, blockHashes, text, failed } = await opsForText(snap.markdown, next)
      const c = await testCore()
      // ops the local splice can't verify are still sent; the server reports them back as `unsaveable` (§12.4 step 5)
      void failed
      return client.save({
        base: { rev: snap.rev, hash: snap.hash, blockHashes },
        ops,
        ...(ops.length > 0 ? { expectHash: c.docHash(text, snap.bom) } : {}),
        cause: so.cause ?? 'edit',
        allowPartial: so.allowPartial ?? true,
      })
    },

    save: (req) => call<SaveResponse>('POST', `/api/save?${fileQ}`, { ...req, clientId, saveId: ++saveId }),

    async createThread(anchor, body) {
      const anchorRev = anchor.kind === 'doc' ? (await client.doc()).rev : anchor.hint.rev
      return call<CreateThreadResponse>('POST', `/api/threads?${fileQ}`, { opKey: newOpKey(), anchor, anchorRev, body })
    },
    reply: (thread, body) => call<MessageResponse>('POST', `/api/threads/${thread}/replies?${fileQ}`, { opKey: newOpKey(), body }),
    resolve: (thread) => call<ThreadOpResponse>('POST', `/api/threads/${thread}/resolve?${fileQ}`, { opKey: newOpKey() }),
    decide: (id, d) => call<DecisionResult>('POST', `/api/suggestions/${id}/${d}?${fileQ}`, { opKey: newOpKey() }),
    handoff: (message, clientDecision = 'waiter') =>
      call<HandoffResult>('POST', `/api/handoff?${fileQ}`, {
        opKey: newOpKey(),
        ...(message === undefined ? {} : { message }),
        clientDecision,
      }),
    setPolicy: (p) => call<SeqResponse>('POST', `/api/policy?${fileQ}`, p),
    readMarker: (req) => call<SeqResponse>('POST', `/api/read-marker?${fileQ}`, req),

    events(eo = {}) {
      const q = new URLSearchParams({ file: o.file, clientId, t: token })
      if (eo.afterSeq !== undefined) q.set('afterSeq', String(eo.afterSeq))
      if (eo.knownRev !== undefined) q.set('knownRev', String(eo.knownRev))
      const path = `/api/events?${q.toString()}`
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<BrowserSseEvent> {
          const ac = new AbortController()
          streams.add(ac)
          try {
            const r = await fetch(origin + path, { headers: { Origin: origin, Accept: 'text/event-stream' }, signal: ac.signal })
            if (!r.ok || !r.body) throw new WebClientError('GET', path, r.status, await r.text().catch(() => ''))
            for await (const f of readSse(r.body, ac.signal)) {
              if (f.kind !== 'message') continue
              yield { event: f.message.event, data: JSON.parse(f.message.data) } as BrowserSseEvent
            }
          } catch (e) {
            if (!ac.signal.aborted) throw e
          } finally {
            ac.abort()
            streams.delete(ac)
          }
        },
      }
    },

    raw: (method, path, init = {}) => rawRequest(host, o.port, method, path, init),

    async close() {
      for (const ac of streams) ac.abort()
      streams.clear()
    },
  }
  return client
}

/**
 * One HTTP request with exactly the given headers, over node:http so `Host` can be set too (fetch overrides it).
 * Bodies that aren't strings are JSON-encoded. The response body streams (an SSE route works).
 */
export function rawRequest(
  host: string,
  port: number,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, method, path, headers: { ...(init.headers ?? {}) } }, (res) => {
      const h = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue
        for (const one of Array.isArray(v) ? v : [v]) h.append(k, one)
      }
      const status = res.statusCode ?? 0
      const noBody = status === 204 || status === 304 || method === 'HEAD'
      resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
