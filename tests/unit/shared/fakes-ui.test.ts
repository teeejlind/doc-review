// @vitest-environment jsdom
// Integrator (day 0): the UI-side fakes P3 builds against (CONTRACTS §2.2, §2.4 item 6, §12.0.3, §12.10, §12.14):
// createFakeDocSession (scripted, and live over MockTransport + fakeApp), createFakeEditor (DOM, test ids, shortcuts,
// selection targets) and web-session's readBootstrap. The editor-bridge rect contract itself is
// tests/contract/editor-bridge.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'
import { buildClipboardPrompt } from '../../../shared/handoff-prompt'
import type { CreateThreadResponse, SessionBootstrap, SessionEvent, TextAnchor, ThreadId } from '../../../shared/types'
import { TESTID } from '../../../shared/constants'
import { createFakeApp, type FakeApp } from '../../fakes/fakeApp'
import { createFakeDocSession, openFakeDocSession, type FakeDocSession } from '../../fakes/FakeDocSession'
import { createFakeEditor } from '../../fakes/FakeEditorBridge'
import { createMockTransport } from '../../fakes/MockTransport'
import { readBootstrap } from '../../fakes/web-session'
import { tmpRoot, type TmpRoot } from '../../helpers/tmpRoot'
import { agentHeaders } from '../../helpers/startServer'

const until = async (cond: () => boolean, ms = 5_000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

function shell(): { host: HTMLElement; toolbarHost: HTMLElement; scrollContainer: HTMLElement } {
  document.body.innerHTML = '<div id="mdr-scroll" style="height:300px;overflow-y:auto"><main><div id="mdr-editor-host"></div></main></div><div id="mdr-toolbar-host"></div>'
  return { host: document.getElementById('mdr-editor-host')!, toolbarHost: document.getElementById('mdr-toolbar-host')!, scrollContainer: document.getElementById('mdr-scroll')! }
}

const textAnchor = (quote: string, block: number): TextAnchor => ({
  kind: 'text', quote, prefix: '', suffix: '', hint: { rev: 0, pos: 0, block, blockHash: '0'.repeat(16), offsetInBlock: 0 },
})

describe('createFakeDocSession (scripted)', () => {
  it('emit() sets state and notifies the matching SessionEvent', () => {
    const s = createFakeDocSession({ file: 'a.md' })
    const seen: SessionEvent[] = []
    s.subscribe((w) => seen.push(w))
    s.emit({ banner: { kind: 'tab-not-leader' } })
    s.emit({ presence: { waiter: 'connected' } })
    s.emit({ recovered: { reason: 'merge-failed', markdown: 'x', baseRev: 1, savedAt: new Date().toISOString() } })
    expect(s.getBanner()).toEqual({ kind: 'tab-not-leader' })
    expect(s.getReview().presence.waiter).toBe('connected')
    expect(s.getRecoveredDraft()?.reason).toBe('merge-failed')
    expect(seen).toEqual(['banner', 'presence', 'recovered'])
    s.takeOver()
    expect(s.getBanner()).toBeNull()
  })

  it('handoff copies the round-null prompt inside the gesture only when presence is none (§12.10)', async () => {
    const copied: string[] = []
    const s = createFakeDocSession({ file: 'a.md', root: '/r', clipboard: { writeText: async (t) => void copied.push(t) } })
    const out = await s.handoff()
    expect(out).toMatchObject({ clientDecision: 'clipboard', copied: true, delivery: 'clipboard' })
    expect(copied).toEqual([buildClipboardPrompt({ file: 'a.md', abs: '/r/a.md', root: '/r', round: null })])
    s.emit({ presence: { waiter: 'grace' } })
    const latched = await s.handoff('again')
    expect(latched).toMatchObject({ clientDecision: 'waiter', copied: false, delivery: 'latched' })
    expect(copied).toHaveLength(1)
    const refused = createFakeDocSession({ clipboard: { writeText: async () => { throw new Error('denied') } } })
    expect((await refused.handoff()).copied).toBe(false)
  })

  it('thread ops mutate the local review state', async () => {
    const s = createFakeDocSession()
    const { thread } = await s.createThread({ kind: 'doc' }, 'Doc note')
    await s.reply(thread.id, 'More')
    await s.resolve(thread.id)
    const t = s.getReview().threads.find((x) => x.id === thread.id)!
    expect(t.status).toBe('resolved')
    expect(t.messages.map((m) => m.body)).toEqual(['Doc note', 'More'])
    expect(s.calls.map((c) => c.method)).toEqual(['createThread', 'reply', 'resolve'])
  })
})

describe('createFakeDocSession (live over MockTransport + fakeApp)', () => {
  let root: TmpRoot
  let fake: FakeApp
  let session: FakeDocSession
  beforeAll(async () => {
    root = tmpRoot({ name: 'fakes-ui-live', fixtures: ['basic.md'] })
    fake = await createFakeApp({ root: root.root, port: 28_998, diskPollMs: 0 })
    const transport = createMockTransport({ app: fake, token: fake.token, port: 28_998 })
    const boot: SessionBootstrap = {
      token: fake.token, root: fake.root, rootHash: fake.rootHash, port: 28_998, file: 'basic.md', fileError: null,
      version: '2.0.0-dev', protocol: 2, schemaFingerprint: '', testHooks: true,
    }
    session = await openFakeDocSession({ boot, file: 'basic.md', transport })
  }, 60_000)
  afterAll(async () => {
    await session?.close()
    await fake?.close()
    root?.cleanup()
  })

  it('loads the real snapshot and review, and a Claude comment arrives over SSE', async () => {
    expect(session.getSnapshot().markdown).toContain('# Launch plan')
    expect(session.getSnapshot().blocks.length).toBeGreaterThan(3)
    const r = await fake.fetch(new Request('http://127.0.0.1:28998/api/agent/batch?file=basic.md', {
      method: 'POST', headers: { ...agentHeaders({ token: fake.token }), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'comment', quote: 'Grow the waitlist', body: 'By how much?' }] }),
    }))
    expect(r.status).toBe(200)
    await until(() => session.getReview().threads.length === 1)
    expect(session.getReview().threads[0]!.createdBy).toBe('Claude')
  })

  it('a doc-removed event raises the doc-removed banner (§12.14)', async () => {
    const store = await fake.store('basic.md')
    await store.simulateRemoval()
    await until(() => session.getBanner()?.kind === 'doc-removed')
    expect(session.getSaveState()).toMatchObject({ state: 'readonly', code: 'DOC_GONE' })
  })
})

describe('createFakeEditor', () => {
  it('renders blocks, highlights and suggestion spans with the frozen test ids; rects in content space', async () => {
    const { host, toolbarHost, scrollContainer } = shell()
    const threadId = `t_${ulid()}` as ThreadId
    const session = createFakeDocSession({ markdown: '# Title\n\nFirst paragraph here.\n\nSecond paragraph.\n' })
    session.emit({
      review: {
        ...session.getReview(),
        threads: [{
          id: threadId, kind: 'comment', status: 'open', autoResolved: false, anchor: textAnchor('Second', 2), lastAnchor: textAnchor('Second', 2),
          resolution: { state: 'exact' }, detached: false, createdBy: 'TJ', createdSeq: 1, lastSeq: 1,
          messages: [{ id: `c_${ulid()}`, by: 'TJ', at: new Date().toISOString(), body: 'x', seq: 1 }], suggestions: [], unread: 0,
        }],
      },
    })
    const ed = await createFakeEditor({ host, toolbarHost, scrollContainer, session })
    expect(host.querySelector(`[data-testid="${TESTID.editor}"]`)).not.toBeNull()
    expect(toolbarHost.querySelector(`[data-testid="${TESTID.modePill}"]`)?.getAttribute('data-mode')).toBe('editing')
    const hl = host.querySelector<HTMLElement>(`[data-testid="${TESTID.highlight}"]`)!
    expect(hl.dataset.thread).toBe(threadId)
    expect(hl.textContent).toBe('Second')
    const r = ed.bridge.getAnchorRects([threadId]).get(threadId)!
    expect(r.top).toBeGreaterThan(0)
    expect(r.bottom).toBeGreaterThan(r.top)
    ed.bridge.setActiveThread(threadId)
    expect(hl.dataset.active).toBe('true')
    ed.bridge.setMode('suggesting')
    expect(host.querySelector<HTMLElement>(`[data-testid="${TESTID.editor}"]`)!.dataset.mode).toBe('suggesting')
    ed.destroy()
    expect(host.innerHTML).toBe('')
    expect(toolbarHost.innerHTML).toBe('')
  })

  it('records registerShortcut bindings and runs them on keydown, newest first (§11.5)', async () => {
    const { host, toolbarHost, scrollContainer } = shell()
    const ed = await createFakeEditor({ host, toolbarHost, scrollContainer, session: createFakeDocSession() })
    const ran: string[] = []
    ed.bridge.registerShortcut({ key: 'Mod-Enter', run: () => (ran.push('old'), true) })
    const off = ed.bridge.registerShortcut({ key: 'Mod-Enter', run: () => (ran.push('new'), true) })
    expect(ed.bridge.shortcuts.map((s) => s.key)).toEqual(['Mod-Enter', 'Mod-Enter'])
    const root = host.querySelector<HTMLElement>(`[data-testid="${TESTID.editor}"]`)!
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true }))
    off()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }))
    expect(ran).toEqual(['new', 'old'])
    ed.destroy()
  })

  it('a scripted selection target feeds createThread; acceptAll goes through the session', async () => {
    const { host, toolbarHost, scrollContainer } = shell()
    const session = createFakeDocSession()
    const ed = await createFakeEditor({ host, toolbarHost, scrollContainer, session })
    const target = { kind: 'anchor' as const, anchor: textAnchor('A paragraph', 1), quote: 'A paragraph', rect: { top: 1, bottom: 2, left: 0 }, extent: { top: 1, bottom: 2 } }
    ed.bridge.setSelectionTarget(target)
    const t = ed.bridge.getSelectionTarget()
    expect(t).toEqual(target)
    const res: CreateThreadResponse = await session.createThread(target.anchor, 'note')
    expect(res.thread.anchor).toEqual(target.anchor)
    expect(await ed.bridge.acceptAll({ by: 'Claude' })).toBeNull()
    ed.destroy()
  })
})

describe("web-session's readBootstrap (§12.0.2)", () => {
  it('reads every mdr-* meta and throws without the token or root', () => {
    document.head.innerHTML = [
      ['mdr-token', 'tok'], ['mdr-root', '/r'], ['mdr-root-hash', 'h'], ['mdr-port', '8301'], ['mdr-file', 'a.md'],
      ['mdr-version', '2.0.0-dev'], ['mdr-protocol', '2'], ['mdr-fingerprint', 'fp'], ['mdr-test-hooks', '1'],
    ].map(([n, c]) => `<meta name="${n}" content="${c}">`).join('')
    expect(readBootstrap(document)).toEqual({
      token: 'tok', root: '/r', rootHash: 'h', port: 8301, file: 'a.md', fileError: null, version: '2.0.0-dev', protocol: 2,
      schemaFingerprint: 'fp', testHooks: true,
    })
    document.head.innerHTML = '<meta name="mdr-root" content="/r"><meta name="mdr-file" content=""><meta name="mdr-file-error" content="FILE_NOT_FOUND">'
    expect(() => readBootstrap(document)).toThrow()
    document.head.innerHTML = '<meta name="mdr-token" content="t"><meta name="mdr-root" content="/r"><meta name="mdr-file" content=""><meta name="mdr-file-error" content="FILE_NOT_FOUND">'
    expect(readBootstrap(document)).toMatchObject({ file: null, fileError: 'FILE_NOT_FOUND', testHooks: false })
  })
})

