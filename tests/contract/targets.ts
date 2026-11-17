// tests/contract/targets.ts (integrator, day 0): the contract suites' adapters to the fakes, kept in one place so the
// suites themselves read as the contract and only this file knows the fakes' constructors.
//   - startFakeTarget: fakeApp (tests/fakes/fakeApp.ts) served on 127.0.0.1:<port> with @hono/node-server, so
//     api.contract.test.ts drives it over real HTTP exactly like P1's server.
//   - fakeSessionFixture: fakeApp in-process plus MockTransport and a SessionBootstrap (session-transport.test.ts).
//   - mountFakeEditor: createFakeDocSession + createFakeEditor mounted into a §12.0.1-shaped DOM
//     (editor-bridge.test.ts).
import type { Server } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import { headlessFingerprint } from '../../core/md/fingerprint'
import { PROTOCOL } from '../../shared/types'
import type { ClientId, EditorBridge, SessionBootstrap, TextAnchor, Thread, ThreadId, Transport } from '../../shared/types'
import { MDR_VERSION } from '../../shared/version'
import { createFakeApp } from '../fakes/fakeApp'
import { createFakeDocSession } from '../fakes/FakeDocSession'
import { createFakeEditor } from '../fakes/FakeEditorBridge'
import { createMockTransport } from '../fakes/MockTransport'

// ---------------------------------------------------------------- fakeApp over HTTP

export async function startFakeTarget(o: { root: string; port: number }): Promise<{ token: string; close(): Promise<void> }> {
  const fa = await createFakeApp({ root: o.root, port: o.port, testHooks: true })
  const server = createAdaptorServer({ fetch: (req: Request) => fa.fetch(req) }) as Server
  server.requestTimeout = 0
  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(o.port, '127.0.0.1', () => {
      server.off('error', rej)
      res()
    })
  })
  return {
    token: fa.token,
    close: async () => {
      await fa.close('stop')
      await new Promise<void>((res) => {
        server.close(() => res())
        server.closeAllConnections()
      })
    },
  }
}

// ---------------------------------------------------------------- fakeApp in-process + MockTransport

export interface FakeSessionFixture {
  boot: SessionBootstrap
  token: string
  /** The X-MDR-Client-Id every MockTransport of this fixture sends. */
  clientId: ClientId
  /** A fresh MockTransport over the fixture's fakeApp. */
  transport(): Transport
  /** A Claude doc comment written through the agent route, not through any transport. */
  agentComment(body: string): Promise<void>
  close(): Promise<void>
}

/** The port fakeApp believes it is served on (never bound: MockTransport calls app.fetch in-process). */
const IN_PROCESS_PORT = 29_999

export async function fakeSessionFixture(o: { root: string; file: string }): Promise<FakeSessionFixture> {
  const fa = await createFakeApp({ root: o.root, port: IN_PROCESS_PORT, testHooks: true })
  const clientId: ClientId = createMockTransport({ app: fa, token: fa.token, port: fa.port }).clientId
  const boot: SessionBootstrap = {
    token: fa.token,
    root: fa.root,
    rootHash: fa.rootHash,
    port: fa.port,
    file: o.file,
    fileError: null,
    version: MDR_VERSION,
    protocol: PROTOCOL,
    schemaFingerprint: await headlessFingerprint(),
    testHooks: false,
  }
  const transports: Array<{ closeAll(): void }> = []
  return {
    boot,
    token: fa.token,
    clientId,
    transport: () => {
      const t = createMockTransport({ app: fa, token: fa.token, port: fa.port, clientId })
      transports.push(t)
      return t
    },
    agentComment: async (body) => {
      const res = await fa.fetch(new Request(`http://127.0.0.1:${fa.port}/api/agent/batch?file=${encodeURIComponent(o.file)}`, {
        method: 'POST',
        headers: { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(PROTOCOL), Authorization: `Bearer ${fa.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: [{ op: 'comment', doc: true, body }] }),
      }))
      if (res.status !== 200) throw new Error(`agentComment: ${res.status} ${await res.text()}`)
    },
    close: async () => {
      for (const t of transports) t.closeAll()
      await fa.close('stop')
    },
  }
}

// ---------------------------------------------------------------- fake editor

export interface MountedFakeEditor {
  bridge: EditorBridge
  scrollContainer: HTMLElement
  /** Ids of the mounted threads, in doc order. */
  threadIds: string[]
  insertBlockAbove(id: string, px: number): Promise<void>
  settled(): Promise<void>
  destroy(): void
}

const FAKE_PARAGRAPHS = 40
/** Paragraph indexes (0-based among the paragraphs) that carry a comment thread. */
const FAKE_THREAD_PARAGRAPHS = [3, 12, 25, 38]

/**
 * A §12.0.1-shaped page (#mdr-app > #mdr-scroll > .mdr-canvas > main.mdr-doc-col > #mdr-editor-host, plus
 * #mdr-toolbar-host) with createFakeDocSession over a 40-paragraph doc and four open text-anchored threads, and
 * createFakeEditor mounted into it with the model layout (jsdom has none).
 */
export async function mountFakeEditor(o: { document: Document }): Promise<MountedFakeEditor> {
  const doc = o.document
  const el = (tag: string, attrs: Record<string, string> = {}): HTMLElement => {
    const e = doc.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
    return e
  }
  const app = el('div', { id: 'mdr-app', class: 'mdr-app', 'data-mode': 'editing' })
  const topbar = el('header', { class: 'mdr-topbar', 'data-testid': 'mdr-topbar' })
  const toolbarHost = el('div', { id: 'mdr-toolbar-host' })
  const scroll = el('div', { id: 'mdr-scroll', class: 'mdr-scroll', 'data-testid': 'mdr-scroll' })
  const canvas = el('div', { class: 'mdr-canvas' })
  const col = el('main', { class: 'mdr-doc-col' })
  const host = el('div', { id: 'mdr-editor-host' })
  topbar.append(toolbarHost)
  col.append(host)
  canvas.append(col, el('aside', { class: 'mdr-rail', 'aria-label': 'Comments', 'data-testid': 'mdr-rail' }))
  scroll.append(canvas)
  app.append(topbar, el('div', { class: 'mdr-banner-slot' }), scroll)
  doc.body.append(app)

  const para = (i: number): string => `Paragraph ${i} talks about item${i}x in some detail.`
  const markdown = `# Fake document\n\n${Array.from({ length: FAKE_PARAGRAPHS }, (_, i) => para(i)).join('\n\n')}\n`
  const threads: Thread[] = FAKE_THREAD_PARAGRAPHS.map((i, k) => {
    const text = para(i)
    const quote = `item${i}x`
    const offsetInBlock = text.indexOf(quote)
    const anchor: TextAnchor = {
      kind: 'text', quote, prefix: text.slice(0, offsetInBlock), suffix: text.slice(offsetInBlock + quote.length),
      hint: { rev: 0, pos: 0, block: i + 1, blockHash: '0'.repeat(16), offsetInBlock },
    }
    return {
      id: `t_01JAB3K9Q2T7V5X8Y0Z1W2E3${String(k).padStart(2, '0')}` as ThreadId, kind: 'comment', status: 'open',
      autoResolved: false, anchor, lastAnchor: anchor, resolution: { state: 'exact' }, detached: false, createdBy: 'TJ',
      createdSeq: k + 1, lastSeq: k + 1, messages: [], suggestions: [], unread: 0,
    }
  })
  const session = createFakeDocSession({ file: 'doc.md', markdown, review: { threads, seq: threads.length } })
  const handle = await createFakeEditor({ host, toolbarHost, scrollContainer: scroll, session, layout: 'model' })
  const frame = (): Promise<void> =>
    new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)))
  return {
    bridge: handle.bridge,
    scrollContainer: scroll,
    threadIds: threads.map((t) => t.id),
    insertBlockAbove: async (id, px) => {
      handle.bridge.insertBlockAbove(id, px)
    },
    settled: async () => {
      await frame()
      await frame()
    },
    destroy: () => {
      handle.destroy()
      app.remove()
    },
  }
}
