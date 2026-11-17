// tests/unit/web/session/helpers.ts (P2). Shared fixtures for the session unit tests:
//   - fixture(): a tmp root served by fakeApp in-process, with MockTransports over it (CONTRACTS §2.5, §12.0.5);
//   - TestPort: a real ProseMirror EditorState over the headless Md, implementing the P2-private EditorPort seam the
//     editor implements in the browser (web/src/session/internals.ts), with helpers to type into a block.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { ulid } from 'ulid'
import { headlessFingerprint } from '../../../../core/md/fingerprint'
import type { Md } from '../../../../core/md/index'
import { contentNodes } from '../../../../core/splice/eq'
import type { Loaded } from '../../../../core/splice/load'
import { PROTOCOL } from '../../../../shared/types'
import type {
  AgentOp, AnchorUpdate, BatchResult, BlockConflict, ClientId, SessionBootstrap, SuggestionId,
} from '../../../../shared/types'
import { MDR_VERSION } from '../../../../shared/version'
import { memoryDraftStore } from '../../../../web/src/session/drafts'
import type { SessionEnv } from '../../../../web/src/session/env'
import type {
  DraftState, EditorPort, ReloadApply, ReopenGroup, SessionInternals, SuggestionPlan,
} from '../../../../web/src/session/internals'
import { sessionInternals } from '../../../../web/src/session/internals'
import { buildMinimalReplaceTr } from '../../../../web/src/session/remote'
import { openSession, type MdrDocSession, type OpenSessionOptions } from '../../../../web/src/session/session'
import type { ChannelLike } from '../../../../web/src/session/tabs'
import { createFakeApp, type FakeApp } from '../../../fakes/fakeApp'
import { sharedMd } from '../../../fakes/FakeDocStore'
import { createMockTransport, type MockTransport } from '../../../fakes/MockTransport'
import { tmpRoot, type TmpRoot } from '../../../helpers/tmpRoot'

export const until = async (cond: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ in-memory BroadcastChannel bus

export function channelBus(): { channel(name: string): ChannelLike } {
  const members = new Map<string, Set<ChannelLike>>()
  return {
    channel(name) {
      let set = members.get(name)
      if (!set) members.set(name, (set = new Set()))
      const peers = set
      const ch: ChannelLike = {
        onmessage: null,
        postMessage(m) {
          const data = structuredClone(m)
          for (const p of peers) if (p !== ch) queueMicrotask(() => p.onmessage?.({ data }))
        },
        close() {
          peers.delete(ch)
        },
      }
      peers.add(ch)
      return ch
    },
  }
}

// ------------------------------------------------------------------ fakeApp fixture

export interface Fixture {
  root: TmpRoot
  fa: FakeApp
  boot: SessionBootstrap
  clientId: ClientId
  /** A fresh MockTransport over the fixture's app (same client id unless given). */
  transport(clientId?: ClientId): MockTransport
  /** A Claude batch through the agent route (not through any transport). */
  agent(ops: AgentOp[]): Promise<BatchResult>
  /** Open a session (memory drafts, no channel, no window listeners by default). */
  open(o?: Partial<OpenSessionOptions> & { port?: TestPort; env?: Partial<SessionEnv> }): Promise<{ session: MdrDocSession; internals: SessionInternals; transport: MockTransport }>
  close(): Promise<void>
}

const IN_PROCESS_PORT = 29_998

export async function fixture(o: { file: string; markdown: string | Buffer; diskPollMs?: number }): Promise<Fixture> {
  const root = tmpRoot({ name: 'p2-session', fixtures: 'none', files: { [o.file]: o.markdown } })
  const fa = await createFakeApp({ root: root.root, port: IN_PROCESS_PORT, testHooks: true, diskPollMs: o.diskPollMs ?? 0 })
  const clientId = `k_${ulid()}` as ClientId
  const boot: SessionBootstrap = {
    token: fa.token, root: fa.root, rootHash: fa.rootHash, port: fa.port, file: o.file, fileError: null, version: MDR_VERSION,
    protocol: PROTOCOL, schemaFingerprint: await headlessFingerprint(), testHooks: true,
  }
  const transports: MockTransport[] = []
  const sessions: MdrDocSession[] = []
  const fx: Fixture = {
    root, fa, boot, clientId,
    transport: (id) => {
      const t = createMockTransport({ app: fa, token: fa.token, port: fa.port, clientId: id ?? clientId })
      transports.push(t)
      return t
    },
    agent: async (ops) => {
      const res = await fa.fetch(new Request(`http://127.0.0.1:${fa.port}/api/agent/batch?file=${encodeURIComponent(o.file)}`, {
        method: 'POST',
        headers: { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(PROTOCOL), Authorization: `Bearer ${fa.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops }),
      }))
      const json = (await res.json()) as BatchResult
      if (res.status !== 200) throw new Error(`agent batch ${res.status}: ${JSON.stringify(json)}`)
      return json
    },
    open: async (oo = {}) => {
      const transport = (oo.transport as MockTransport | undefined) ?? fx.transport()
      const env: Partial<SessionEnv> = {
        drafts: memoryDraftStore(), channel: () => null, window: null, document: null, clipboard: () => null,
        idle: (fn) => setTimeout(fn, 0), reloadPage: () => undefined, storage: null, ...(oo.env ?? {}),
      }
      const session = await openSession({ boot, file: o.file, transport, env, ...(oo.tabs ? { tabs: oo.tabs } : {}) })
      sessions.push(session)
      const internals = sessionInternals.get(session)!
      if (oo.port) {
        oo.port.internals = internals
        await internals.attachEditor(oo.port)
      }
      return { session, internals, transport }
    },
    close: async () => {
      for (const s of sessions) await s.close().catch(() => undefined)
      for (const t of transports) t.closeAll()
      await fa.close('stop')
      root.cleanup()
    },
  }
  return fx
}

// ------------------------------------------------------------------ TestPort: the editor seam over an EditorState

export class TestPort implements EditorPort {
  state!: EditorState
  gen = 0
  composing = false
  editable: boolean | null = null
  internals: SessionInternals | null = null
  readonly reloads: ReloadApply[] = []
  readonly decisions: Array<{ ids: SuggestionId[]; decision: 'accept' | 'reject'; bulk?: string }> = []
  readonly refusedReopens: ReopenGroup[] = []
  readonly committedCalls: Array<{ anchors: AnchorUpdate[]; upserted: SuggestionId[]; withdrawn: SuggestionId[] }> = []
  readonly tookTheirs: BlockConflict[] = []
  readonly installs: Loaded[] = []
  plan: SuggestionPlan = { upsert: [], withdraw: [], reopen: [] }
  stable = new Map<SuggestionId, number>()
  anchors: AnchorUpdate[] = []
  /** decisionApplied's answer (false = an unplaced suggestion). */
  placed = true
  /** What decisionApplied does to the live doc (the real editor dispatches applySuggestion / revertSuggestion). */
  onDecision: ((o: { ids: SuggestionId[]; decision: 'accept' | 'reject'; bulk?: string }) => void) | null = null
  restoreOk = true

  constructor(readonly md: Md) {}

  static async create(): Promise<TestPort> {
    return new TestPort(await sharedMd())
  }

  install(L: Loaded): void {
    this.installs.push(L)
    this.state = EditorState.create({ doc: L.doc })
  }
  changeGen(): number {
    return this.gen
  }
  isComposing(): boolean {
    return this.composing
  }
  baseDoc(): PMNode {
    return this.state.doc
  }
  suggestionPlan(): SuggestionPlan {
    const p = this.plan
    // reopen candidates are answered once (the review refresh after a reopen removes them in the real editor)
    this.plan = { ...p, reopen: [] }
    return p
  }
  marksStableSince(id: SuggestionId): number | undefined {
    return this.stable.get(id)
  }
  anchorUpdates(): AnchorUpdate[] {
    return this.anchors
  }
  committed(o: { L: Loaded; anchors: AnchorUpdate[]; upserted: SuggestionId[]; withdrawn: SuggestionId[] }): void {
    this.committedCalls.push({ anchors: o.anchors, upserted: o.upserted, withdrawn: o.withdrawn })
    this.anchors = []
    this.plan = {
      ...this.plan,
      upsert: this.plan.upsert.filter((u) => !o.upserted.includes(u.id)),
      withdraw: this.plan.withdraw.filter((w) => !o.withdrawn.includes(w)),
    }
  }
  applyReload(o: ReloadApply): void {
    this.reloads.push(o)
    const tr = buildMinimalReplaceTr(this.state, o.prev, o.next, { preserve: o.preserve })
    if (tr) this.state = this.state.apply(tr)
  }
  reviewChanged(): void {}
  decisionApplied(o: { ids: SuggestionId[]; decision: 'accept' | 'reject'; bulk?: string }): boolean {
    this.decisions.push(o)
    this.onDecision?.(o)
    return this.placed
  }
  reopenRefused(g: ReopenGroup): void {
    this.refusedReopens.push(g)
  }
  draftState(): DraftState {
    const s = this.state.selection
    return { liveDoc: this.state.doc.toJSON(), selection: { anchor: s.anchor, head: s.head }, mode: 'editing' }
  }
  restoreDraft(d: { liveDoc: unknown; selection: DraftState['selection'] }): boolean {
    if (!this.restoreOk) return false
    try {
      const doc = this.md.schema.nodeFromJSON(d.liveDoc)
      doc.check()
      this.state = EditorState.create({ doc })
      if (d.selection) {
        const max = doc.content.size
        this.state = this.state.apply(this.state.tr.setSelection(TextSelection.create(doc, Math.min(d.selection.anchor, max), Math.min(d.selection.head, max))))
      }
      this.bump()
      return true
    } catch {
      return false
    }
  }
  liveMarkdown(): string {
    return this.md.serializeNodes(contentNodes(this.state.doc))
  }
  markdownOf(liveDoc: unknown): string | null {
    try {
      return this.md.serializeNodes(contentNodes(this.md.schema.nodeFromJSON(liveDoc)))
    } catch {
      return null
    }
  }
  replaceAll(markdown: string): void {
    const doc = this.md.parseDoc(markdown)
    this.state = this.state.apply(this.state.tr.replaceWith(0, this.state.doc.content.size, doc.content))
    this.bump()
  }
  takeTheirs(c: BlockConflict, L: Loaded): void {
    this.tookTheirs.push(c)
    if (c.currentIndex === null) return
    const target = L.entries[c.currentIndex]
    if (!target) return
    const { from, to } = this.topRange(c.currentIndex)
    this.state = this.state.apply(this.state.tr.replaceWith(from, to, target.nodes))
    this.bump()
  }
  setEditable(e: boolean): void {
    this.editable = e
  }

  // ---------------------------------------------------------------- test helpers

  /** Doc range of top-level node `index`. */
  topRange(index: number): { from: number; to: number } {
    let pos = 0
    for (let i = 0; i < index; i++) pos += this.state.doc.child(i).nodeSize
    return { from: pos, to: pos + this.state.doc.child(index).nodeSize }
  }
  /** Replace the text of top-level textblock `index` (a user edit). */
  setText(index: number, text: string): void {
    const { from, to } = this.topRange(index)
    this.state = this.state.apply(this.state.tr.replaceWith(from + 1, to - 1, text ? this.md.schema.text(text) : []))
    this.bump()
  }
  /** Replace the text of top-level textblock `index` with a programmatic (decide / hydrate) transaction: not dirty. */
  applyText(index: number, text: string): void {
    const { from, to } = this.topRange(index)
    this.state = this.state.apply(this.state.tr.replaceWith(from + 1, to - 1, text ? this.md.schema.text(text) : []))
  }
  /** Insert a paragraph after top-level node `index` (a user edit). */
  insertParagraphAfter(index: number, text: string): void {
    const { to } = this.topRange(index)
    this.state = this.state.apply(this.state.tr.insert(to, this.md.schema.nodes.paragraph!.create(null, this.md.schema.text(text))))
    this.bump()
  }
  /** Put a collapsed cursor `offset` characters into top-level textblock `index`. */
  caret(index: number, offset: number): void {
    const { from } = this.topRange(index)
    this.state = this.state.apply(this.state.tr.setSelection(TextSelection.create(this.state.doc, from + 1 + offset)))
  }
  text(index: number): string {
    return this.state.doc.child(index).textContent
  }
  bump(): void {
    this.gen++
    this.internals?.changed()
  }
}

/** POST bodies sent to a route (path before '?'). */
export function bodiesTo<T>(t: MockTransport, path: string): T[] {
  return t.requestsTo(path, 'POST').map((r) => r.body as T)
}
