// tests/unit/web/threads/mount.tsx (P3): mounts RailView over the fake session and fake editor (model layout, real
// content coordinates) with a manual animation-frame queue, a shared selection watch and command hub, and the top bar's
// comment controls. Not a test file itself.
import { act, render, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import type { BlockConflict, ReviewState, SelectionTarget, Suggestion, SuggestionId, Thread } from '../../../../shared/types'
import { createFakeDocSession, type FakeDocSession } from '../../../fakes/FakeDocSession'
import { createFakeEditor, type FakeEditorBridge } from '../../../fakes/FakeEditorBridge'
import { createCommandHub } from '../../../../web/src/rail/commands'
import { RailView } from '../../../../web/src/rail/RailView'
import type { RailFrame } from '../../../../web/src/rail/scheduler'
import type { ToastInput } from '../../../../web/src/shell/toast-store'
import { createSelectionWatch } from '../../../../web/src/threads/selection'
import { TopbarThreads } from '../../../../web/src/threads/TopbarThreads'
import { frameQueue, paragraphs } from '../shell/helpers'

export const sid = (n: number): SuggestionId => `s_${String(n).padStart(26, '0')}`

export function suggestionFor(t: Thread, n: number, o: Partial<Suggestion> = {}): Suggestion {
  if (t.anchor.kind !== 'text') throw new Error('suggestionFor needs a text-anchored thread')
  return {
    id: sid(n), thread: t.id, by: 'Claude', status: 'pending', anchor: t.anchor, createdSeq: n, updatedSeq: n,
    range: { start: t.anchor.hint.block, end: t.anchor.hint.block + 1, rev: 0 }, base: 'old text', proposed: 'new text',
    hunks: [{ del: t.anchor.quote, ins: `${t.anchor.quote}!`, at: 0 }], located: { start: t.anchor.hint.block, end: t.anchor.hint.block + 1 }, ...o,
  }
}

export interface MountOptions {
  threads?: Thread[]
  suggestions?: Suggestion[]
  review?: Partial<ReviewState>
  conflicts?: BlockConflict[]
  markdown?: string
  clipboard?: { writeText(s: string): Promise<void> } | null
  /** container.clientHeight (default 800). */
  viewportHeight?: number
  /** Toasts the rail raises (resolve → Undo). */
  onToast?: (t: ToastInput) => void
}

export async function mountRail(o: MountOptions = {}) {
  document.body.innerHTML = '<div id="topbar"></div><div id="scroll"><main><div id="host"></div></main><aside id="rail"></aside></div><div id="toolbar"></div>'
  const container = document.getElementById('scroll')!
  // jsdom has no layout: give the scroll container a viewport so the visible band isn't empty
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: o.viewportHeight ?? 800 })
  const rail = document.getElementById('rail')!
  const host = document.getElementById('host')!
  const session: FakeDocSession = createFakeDocSession({
    file: 'doc.md',
    markdown: o.markdown ?? paragraphs(12),
    review: { file: 'doc.md', threads: o.threads ?? [], suggestions: o.suggestions ?? [], ...(o.review ?? {}) },
    conflicts: o.conflicts ?? [],
    ...(o.clipboard !== undefined ? { clipboard: o.clipboard } : {}),
  })
  const editor = await createFakeEditor({ host, toolbarHost: document.getElementById('toolbar')!, scrollContainer: container, session })
  const bridge = editor.bridge as FakeEditorBridge
  const fq = frameQueue()
  const watch = createSelectionWatch({ bridge, raf: fq.raf, caf: fq.caf })
  const hub = createCommandHub()
  const frames: RailFrame[] = []
  render(
    <RailView
      bridge={bridge}
      session={session}
      container={container}
      rail={rail}
      content={host}
      selection={watch}
      commands={hub}
      onFrame={(f) => frames.push(f)}
      {...(o.onToast ? { onToast: o.onToast } : {})}
      schedulerOptions={{ raf: fq.raf, caf: fq.caf, ResizeObserver: null, fonts: null }}
      readMarkerOptions={{ IntersectionObserver: null }}
    />,
    { container: rail },
  )
  render(<TopbarThreads commands={hub.commands} selection={watch} navCount={hub.navCount} />, { container: document.getElementById('topbar')! })
  const positioned = (o.threads ?? []).filter((t) => t.anchor.kind !== 'doc' && !t.detached && t.status === 'open').length
  await waitFor(() => expect(rail.querySelectorAll(`.mdr-card--rail[data-testid="${TESTID.card}"]`).length).toBeGreaterThanOrEqual(positioned))
  act(() => fq.run())

  const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document): E => {
    const el = root.querySelector<E>(sel)
    if (!el) throw new Error(`no element for ${sel}`)
    return el
  }
  const byTestId = (key: keyof typeof TESTID, attrs: Record<string, string> = {}, root: ParentNode = document): HTMLElement =>
    $(`[data-testid="${TESTID[key]}"]` + Object.entries(attrs).map(([k, v]) => `[${k}="${v}"]`).join(''), root)
  const all = (key: keyof typeof TESTID, root: ParentNode = document): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${TESTID[key]}"]`))
  const card = (id: string): HTMLElement => byTestId('card', { 'data-thread': id })
  const frame = (): void => act(() => fq.run())
  const editorRoot = (): HTMLElement => $('[data-testid="mdr-editor"]', host)
  const scriptSelection = (t: SelectionTarget | undefined): void => {
    act(() => bridge.setSelectionTarget(t))
    frame()
  }
  return { container, rail, host, session, editor, bridge, fq, watch, hub, frames, $, byTestId, all, card, frame, editorRoot, scriptSelection }
}

export function textTarget(block: number, quote: string, top: number, bottom = top + 24): Exclude<SelectionTarget, null> {
  return {
    kind: 'anchor',
    quote,
    anchor: { kind: 'text', quote, prefix: '', suffix: '', hint: { rev: 0, pos: block * 100, block, blockHash: '0'.repeat(16), offsetInBlock: 0 } },
    rect: { top, bottom: top + 24, left: 0 },
    extent: { top, bottom },
  }
}

export async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
