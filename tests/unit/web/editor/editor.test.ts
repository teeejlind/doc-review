// tests/unit/web/editor/editor.test.ts (P2; CONTRACTS §3.2, §12.0.3, §12.0.4, §12.2.4, §12.13 toolbar, §12.15). The
// entry point and its lifecycle: the createMd fingerprint assertion, the TypeError guard, the debug hooks, destroy,
// modes (pill, data-mode, persistence), read-only, typing activity and the toolbar.
import { afterEach, describe, expect, it } from 'vitest'
import { $node } from '@milkdown/kit/utils'
import { TextSelection } from '@milkdown/kit/prose/state'
import { createMd } from '../../../../core/md/index'
import { ptextOf } from '../../../../core/ptext'
import { load } from '../../../../core/splice/load'
import { StoreError } from '../../../../shared/errors'
import { CONSTANTS, TESTID } from '../../../../shared/constants'
import type { EditorDebugHooks } from '../../../../shared/types'
import { createEditor } from '../../../../web/src/editor/index'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { find, mount, replace, tick, until, type Mounted } from './helpers'
import { fixture } from '../session/helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = '# Title\n\nHello brave world.\n\nAnother line here.\n'
const dbg = (): EditorDebugHooks | undefined => (globalThis as unknown as { __mdrDebug?: EditorDebugHooks }).__mdrDebug

describe('createMd fingerprint assertion (§3.2)', () => {
  it('a schema-altering extend is refused with CONTRACT_MISMATCH; a plugins-only extend passes', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const extra = $node('mdr_extra_node', () => ({ group: 'block', content: 'text*', parseMarkdown: { match: () => false, runner: () => {} }, toMarkdown: { match: () => false, runner: () => {} } }))
    await expect(createMd({ root: host, extend: (e) => e.use(extra) })).rejects.toSatisfy((e: unknown) => e instanceof StoreError && e.code === 'CONTRACT_MISMATCH')
    const ok = await createMd({ root: host, extend: (e) => e })
    expect(ok.live).toBe(true)
    await ok.destroy()
    host.remove()
  })
})

describe('createEditor (§12.0.3)', () => {
  it('throws TypeError for a session openDocSession did not make', async () => {
    const host = document.createElement('div')
    const fake = createFakeDocSession({})
    await expect(createEditor({ host, toolbarHost: document.createElement('div'), scrollContainer: document.createElement('div'), session: fake })).rejects.toBeInstanceOf(TypeError)
  })

  it('mounts the editor root with its test ids; the debug hooks agree with the server; destroy empties both hosts', async () => {
    m = await mount({ markdown: MD })
    const root = m.host.querySelector<HTMLElement>(`[data-testid="${TESTID.editor}"]`)!
    expect(root.dataset.mode).toBe('editing')
    expect(root.dataset.readonly).toBe('false')
    expect(m.toolbarHost.querySelector(`[data-testid="${TESTID.toolbar}"]`)).not.toBeNull()
    expect(m.toolbarHost.querySelector(`[data-testid="${TESTID.modePill}"]`)?.getAttribute('data-mode')).toBe('editing')
    const d = dbg()!
    expect(d).toBeDefined()
    const snap = m.session.getSnapshot()
    expect(d.blocks().map((b) => [b.hash, b.start, b.end, b.fidelity])).toEqual(snap.blocks.map((b) => [b.hash, b.start, b.end, b.fidelity]))
    const L = load(m.ed.md, snap.markdown)
    const p = ptextOf(L.doc, L)
    expect(d.ptext()).toEqual({ text: p.text, blockRanges: p.blockRanges })
    expect(d.planSave()).toEqual([])
    expect(d.liveMarkdown()).toBe(MD)
    expect(d.bridge()).toBe(m.bridge)
    expect(d.session()).toBe(m.session)
    await d.settled()
    m.handle.destroy()
    expect(m.host.childNodes.length).toBe(0)
    expect(m.toolbarHost.childNodes.length).toBe(0)
    expect(dbg()).toBeUndefined()
  })

  it('failSplice holds the op covering the faulted block as unsaveable; the rest still saves', async () => {
    m = await mount({ markdown: '# Title\n\nHello brave world.\n\nA middle line.\n\nAnother line here.\n' })
    const h = m.session.getSnapshot().blocks[1]!.hash
    dbg()!.failSplice([h])
    await m.fx.fa.fetch(new Request(`http://127.0.0.1:${m.fx.fa.port}/__test/splice-fault`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.fx.fa.token}`, 'X-MDR-Client': 'web' },
      body: JSON.stringify({ file: 'doc.md', blockHashes: [h] }),
    }))
    replace(m.view, 'brave', 'bold')
    replace(m.view, 'Another', 'One more')
    await m.session.flush().catch(() => undefined)
    await until(() => m!.session.getConflicts().some((c) => c.kind === 'unsaveable'))
    const disk = m.fx.root.read('doc.md')
    expect(disk).toContain('Hello brave world.')
    expect(disk).toContain('One more line here.')
    dbg()!.failSplice([])
  })
})

describe('modes (§12.2.4)', () => {
  it('the pill toggles modes and data-mode follows; the mode is not remembered (every open starts in Suggesting)', async () => {
    m = await mount({ markdown: MD })
    const pill = m.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.modePill}"]`)!
    const reasons: string[] = []
    m.bridge.onLayoutInvalidated((r) => reasons.push(r))
    pill.click()
    expect(m.bridge.getMode()).toBe('suggesting')
    expect(pill.dataset.mode).toBe('suggesting')
    expect(m.host.querySelector<HTMLElement>(`[data-testid="${TESTID.editor}"]`)!.dataset.mode).toBe('suggesting')
    expect(reasons).toContain('mode')
    pill.click()
    expect(m.bridge.getMode()).toBe('editing')
    expect(Object.keys(localStorage).filter((k) => k.startsWith('mdr:mode:'))).toEqual([])
  })

  it('a doc opens in Suggesting, even when an old per-doc memory says Editing (TJ, 2026-11-16)', async () => {
    const fx = await fixture({ file: 'doc.md', markdown: MD })
    m = await mount({ markdown: MD, fx, mode: 'as-loaded' })
    expect(m.bridge.getMode()).toBe('suggesting')
    const pill = m.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.modePill}"]`)!
    expect(pill.dataset.mode).toBe('suggesting')
    localStorage.setItem(`mdr:mode:${m.internals.boot.rootHash}:doc.md`, 'editing')
    pill.click()
    expect(m.bridge.getMode()).toBe('editing')
    // reopen: Suggesting again
    m.handle.destroy()
    m.host.closest('#mdr-app')?.remove()
    const m2 = await mount({ markdown: MD, fx, mode: 'as-loaded' })
    expect(m2.bridge.getMode()).toBe('suggesting')
    await m2.close()
    m = null
  })

  it('read-only: user edits are dropped and data-readonly is set; programmatic loads still apply', async () => {
    m = await mount({ markdown: MD })
    m.ed.setEditable(false)
    expect(m.host.querySelector<HTMLElement>(`[data-testid="${TESTID.editor}"]`)!.dataset.readonly).toBe('true')
    const before = m.view.state.doc
    replace(m.view, 'brave', 'timid')
    expect(m.view.state.doc.eq(before)).toBe(true)
    await m.fx.agent([{ op: 'replace_block', target: { quote: 'Another line here.' }, markdown: 'Another line, by Claude.' } as never])
    await until(() => m!.view.state.doc.textContent.includes('by Claude'))
  })

  it('onTypingActivity: true on a user edit, false after TYPING_IDLE_MS', async () => {
    m = await mount({ markdown: MD })
    const seen: boolean[] = []
    m.bridge.onTypingActivity((b) => seen.push(b))
    replace(m.view, 'brave', 'brave,')
    expect(seen).toEqual([true])
    await tick(CONSTANTS.TYPING_IDLE_MS + 100)
    expect(seen).toEqual([true, false])
  })
})

describe('toolbar (§12.13)', () => {
  it('buttons carry data-action and aria-pressed; bold and the heading menu apply', async () => {
    m = await mount({ markdown: MD })
    const btn = (a: string): HTMLButtonElement => m!.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="${a}"]`)!
    for (const a of ['bold', 'italic', 'strike', 'code', 'link', 'heading', 'heading-0', 'heading-1', 'heading-2', 'heading-3', 'bullet', 'ordered', 'task', 'blockquote', 'code-block', 'hr']) {
      expect(btn(a)).not.toBeNull()
    }
    const r = find(m.view, 'brave')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from, r.to)))
    btn('bold').click()
    expect(m.view.state.doc.rangeHasMark(r.from, r.to, m.view.state.schema.marks.strong!)).toBe(true)
    m.ed.toolbar.update(m.view.state, true)
    expect(btn('bold').getAttribute('aria-pressed')).toBe('true')
    btn('heading').click()
    btn('heading-2').click()
    expect(m.view.state.selection.$from.parent.type.name).toBe('heading')
    expect(m.view.state.selection.$from.parent.attrs.level).toBe(2)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toContain('## Hello **brave** world.')
  })

  it('QA3: the toolbar is one tab stop; arrows, Home and End move inside it', async () => {
    m = await mount({ markdown: MD })
    const root = m.toolbarHost.querySelector<HTMLElement>('.mdr-toolbar')!
    const top = (): HTMLButtonElement[] => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.closest('.mdr-toolbar__menu'))
    const stops = (): HTMLButtonElement[] => top().filter((b) => b.tabIndex >= 0)
    const key = (el: HTMLElement, k: string): void => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    // one stop, and the heading menu's items are not stops while it is open either
    expect(stops()).toHaveLength(1)
    expect(top().length).toBeGreaterThan(10)
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-toolbar__menu button')).every((b) => b.tabIndex === -1)).toBe(true)
    const first = top()[0]!
    expect(stops()[0]).toBe(first)
    first.focus()
    key(first, 'ArrowRight')
    expect(document.activeElement).toBe(top()[1])
    expect(stops()).toEqual([top()[1]])
    key(top()[1]!, 'End')
    expect(document.activeElement).toBe(top().at(-1))
    key(top().at(-1)!, 'ArrowRight')
    expect(document.activeElement).toBe(top()[0])
    key(top()[0]!, 'ArrowLeft')
    expect(document.activeElement).toBe(top().at(-1))
    key(top().at(-1)!, 'Home')
    expect(document.activeElement).toBe(top()[0])
    // the stop follows focus that arrives some other way (a click, a screen reader's virtual cursor)
    const third = top()[2]!
    third.focus()
    expect(stops()).toEqual([third])
  })

  it('QA3: Text style names the current style, and is not shaded as if it were toggled on', async () => {
    m = await mount({ markdown: MD })
    const heading = m.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="heading"]`)!
    // the caret starts in the H1
    m.ed.toolbar.update(m.view.state, true)
    expect(heading.textContent).toContain('Heading 1')
    expect(heading.hasAttribute('aria-pressed')).toBe(false)
    expect(heading.getAttribute('aria-label')).toBe('Text style: Heading 1')
    const r = find(m.view, 'brave')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from, r.to)))
    m.ed.toolbar.update(m.view.state, true)
    expect(heading.textContent).toContain('Normal text')
    expect(heading.getAttribute('aria-label')).toBe('Text style: Normal text')
    expect(heading.hasAttribute('aria-pressed')).toBe(false)
  })

  it('QA3: every toolbar button’s visible text is part of its accessible name (WCAG 2.5.3), and the list and block buttons are drawn icons', async () => {
    m = await mount({ markdown: MD })
    const visible = (b: HTMLElement): string => {
      const c = b.cloneNode(true) as HTMLElement
      for (const x of Array.from(c.querySelectorAll('[aria-hidden="true"]'))) x.remove()
      return (c.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    const alnum = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    for (const b of Array.from(m.toolbarHost.querySelectorAll<HTMLButtonElement>('button'))) {
      const text = alnum(visible(b))
      if (!text) continue
      expect(alnum(b.getAttribute('aria-label') ?? ''), `${b.dataset.action}: "${visible(b)}" in "${b.getAttribute('aria-label')}"`).toContain(text)
    }
    for (const a of ['bullet', 'ordered', 'task', 'blockquote', 'code-block', 'hr']) {
      const b = m.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="${a}"]`)!
      expect(b.querySelector('svg'), a).not.toBeNull()
      expect(visible(b), a).toBe('')
    }
  })

  it('the Text style menu works from the keyboard: arrows move through it, Escape closes it and returns to the button (QA1: unverified 40)', async () => {
    m = await mount({ markdown: MD })
    const btn = (a: string): HTMLButtonElement => m!.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="${a}"]`)!
    const key = (el: HTMLElement, k: string): void => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    const menu = m.toolbarHost.querySelector<HTMLElement>('.mdr-toolbar__menu')!
    btn('heading').focus()
    key(btn('heading'), 'ArrowDown')
    expect(menu.hidden).toBe(false)
    expect(document.activeElement).toBe(btn('heading-0'))
    key(btn('heading-0'), 'ArrowDown')
    expect(document.activeElement).toBe(btn('heading-1'))
    key(btn('heading-1'), 'ArrowUp')
    key(btn('heading-0'), 'ArrowUp')
    expect(document.activeElement).toBe(btn('heading-3'))
    key(btn('heading-3'), 'Escape')
    expect(menu.hidden).toBe(true)
    expect(document.activeElement).toBe(btn('heading'))
  })
})
