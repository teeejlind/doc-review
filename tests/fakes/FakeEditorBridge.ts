// tests/fakes/FakeEditorBridge.ts (integrator, day 0; CONTRACTS §2.2 "Editor factory" / "Editor ↔ UI", §11.5, §12.0.3,
// §12.1, §12.15, D28). Browser-safe: no node:*, no core/, no ProseMirror.
//
// createFakeEditor renders the session's document as real DOM into `host` (one element per block), with comment
// highlights (`data-testid="mdr-highlight"`, `data-thread`, `data-active`), suggestion spans (`mdr-suggestion`,
// `data-suggestion`, `data-kind` ins/del, `data-by`) and conflict blocks (`mdr-conflict-block`), plus a minimal
// toolbar with the mode pill in `toolbarHost`. Every AnchorRect is in scroll-container CONTENT coordinates with the
// §12.0.3 formula (top = r.top − C.top + scrollTop − clientTop), so P3's rail code runs on the real coordinate space.
//
// Layout: in a browser ('dom') rects come from real layout. Under jsdom, which has no layout, 'model' gives each block
// a synthetic height (lineHeight per source line + blockGap) and installs getBoundingClientRect on the elements it
// renders, consistent with the same formula, so tests/contract/editor-bridge.contract.ts holds in vitest too
// (including "insert a 200 px block above → the rect moves by 200 ± 1 px", via `insertBlockAbove`).
//
// Bindings registered with registerShortcut are recorded (`shortcuts`) and also run on keydown inside the editor root,
// newest first, so P3's editor-scoped keys work in fake-backed e2e specs.
import type {
  AnchorRect, Author, BlockAnchor, BlockConflict, BulkDecisionResult, CreateEditorOptions, DocSnapshot, EditorBridge,
  EditorHandle, EditorNotice, ErrorCode, Mode, SelectionTarget, ShortcutBinding, Suggestion, SuggestionId,
  SuggestionSummary, TextAnchor, Thread, ThreadId, Unsubscribe,
} from '../../shared/types'
import { CONSTANTS } from '../../shared/constants'
import type { FakeDocSession } from './FakeDocSession'

export interface CreateFakeEditorOptions extends CreateEditorOptions {
  /** 'dom' = real layout (a browser); 'model' = synthetic rects (jsdom). 'auto' (default) picks 'model' under jsdom. */
  layout?: 'auto' | 'dom' | 'model'
  /** Model layout: px per source line. Default 24. */
  lineHeight?: number
  /** Model layout: px between blocks. Default 12. */
  blockGap?: number
  /** Model layout: px above the first block. Default 16. */
  topPadding?: number
}

type LayoutReason = 'doc' | 'decorations' | 'reload' | 'mode' | 'resize'
type Rect = { top: number; bottom: number; left: number }

export interface FakeEditorBridge extends EditorBridge {
  /** Every registerShortcut binding still registered, in registration order (§11.5). */
  readonly shortcuts: readonly ShortcutBinding[]
  /** Every bridge call, in order. */
  readonly calls: Array<{ method: string; args: unknown[] }>
  readonly layoutMode: 'dom' | 'model'
  /** Script getSelectionTarget(); undefined = derive it from the live DOM selection. */
  setSelectionTarget(t: SelectionTarget | undefined): void
  /** Override getSuggestionSummaries(); null = derive from the review state. */
  setSuggestionSummaries(m: Map<SuggestionId, SuggestionSummary> | null): void
  /** Script the next accept/reject answer(s); undefined = go through the session. */
  setDecisionResult(r: { ok: boolean; noop?: true; code?: ErrorCode } | undefined): void
  emitNotice(n: EditorNotice): void
  emitTyping(typing: boolean): void
  emitHighlightClick(thread: ThreadId): void
  emitLayout(reason: LayoutReason): void
  /** Insert a block exactly `px` tall directly above the block holding anchor `id`; fires onLayoutInvalidated('doc'). */
  insertBlockAbove(id: string, px: number): void
  /** Re-render from the session now (normally automatic on 'doc' / 'review' / 'conflicts'). */
  render(): void
  /** The rendered block elements (in doc order). */
  blockElements(): HTMLElement[]
}

interface ViewBlock { index: number; source: string; text: string; hash: string; kind: string; mdType: string }
type Span = { start: number; end: number; kind: 'hl' | 'del' | 'ins'; thread?: ThreadId; suggestion?: SuggestionId; by?: Author; insText?: string }

const ZERO16 = '0'.repeat(16)

/** Light rendering of one block's markdown: heading hashes, list and quote markers, emphasis and code ticks removed. */
export function displayText(source: string): string {
  return source
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''))
    .join('\n')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
}

function viewBlocks(snap: DocSnapshot): ViewBlock[] {
  if (snap.blocks.length) {
    return snap.blocks.map((b) => {
      const source = snap.markdown.slice(b.start, b.end)
      return { index: b.index, source, text: displayText(source), hash: b.hash, kind: b.kind, mdType: b.mdType }
    })
  }
  const out: ViewBlock[] = []
  for (const part of snap.markdown.split(/\r?\n[ \t]*\r?\n/)) {
    const source = part.replace(/^\s+|\s+$/g, '')
    if (!source) continue
    out.push({ index: out.length, source, text: displayText(source), hash: ZERO16, kind: 'md', mdType: 'paragraph' })
  }
  return out
}

const isAtom = (b: ViewBlock): boolean => b.kind === 'raw' || b.kind === 'frontmatter' || b.mdType === 'thematicBreak'

function keyOf(e: KeyboardEvent): string {
  let k = e.key
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase()
  else if (e.code === 'BracketRight') k = ']'
  else if (e.code === 'BracketLeft') k = '['
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5)
  return `${e.metaKey || e.ctrlKey ? 'Mod-' : ''}${e.altKey ? 'Alt-' : ''}${e.shiftKey && k.length > 1 ? 'Shift-' : ''}${k}`
}
function normBinding(k: string): string {
  // prosemirror-keymap syntax: modifiers in any order, Cmd/Meta/Ctrl all mean Mod here
  const parts = k.split('-')
  const key = parts.pop()!
  const mods = new Set(parts.map((p) => (/^(cmd|meta|ctrl|c|m|mod)$/i.test(p) ? 'Mod' : /^(alt|a|option)$/i.test(p) ? 'Alt' : /^(shift|s)$/i.test(p) ? 'Shift' : p)))
  return `${mods.has('Mod') ? 'Mod-' : ''}${mods.has('Alt') ? 'Alt-' : ''}${mods.has('Shift') && key.length > 1 ? 'Shift-' : ''}${key.length === 1 ? key.toLowerCase() : key}`
}

export async function createFakeEditor(o: CreateFakeEditorOptions): Promise<EditorHandle & { bridge: FakeEditorBridge }> {
  const { host, toolbarHost, scrollContainer: sc } = o
  const session = o.session as FakeDocSession
  const doc = host.ownerDocument
  const win = doc.defaultView
  const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)
  const layoutMode: 'dom' | 'model' = o.layout === 'dom' || o.layout === 'model' ? o.layout : jsdom ? 'model' : 'dom'
  const lineHeight = o.lineHeight ?? 24
  const blockGap = o.blockGap ?? 12
  const topPadding = o.topPadding ?? 16

  let mode: Mode = 'editing'
  let activeThread: string | null = null
  let visible: Set<ThreadId> | null = null
  let scriptedSelection: SelectionTarget | undefined
  let scriptedSummaries: Map<SuggestionId, SuggestionSummary> | null = null
  let scriptedDecision: { ok: boolean; noop?: true; code?: ErrorCode } | undefined
  const spacers = new Map<number, number[]>() // block index -> spacer heights inserted above it
  const shortcuts: ShortcutBinding[] = []
  const calls: Array<{ method: string; args: unknown[] }> = []
  const modeSubs = new Set<(m: Mode) => void>()
  const layoutSubs = new Set<(r: LayoutReason) => void>()
  const selSubs = new Set<() => void>()
  const hlSubs = new Set<(t: ThreadId) => void>()
  const noticeSubs = new Set<(n: EditorNotice) => void>()
  const typingSubs = new Set<(b: boolean) => void>()
  const placed = new Set<SuggestionId>()
  const call = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
  }
  const fire = (r: LayoutReason): void => {
    for (const cb of [...layoutSubs]) cb(r)
  }

  // ------------------------------------------------------------------ DOM skeleton

  host.innerHTML = ''
  toolbarHost.innerHTML = ''
  const editorRoot = doc.createElement('div')
  editorRoot.className = 'mdr-fake-editor'
  editorRoot.dataset.testid = 'mdr-editor'
  editorRoot.dataset.mode = mode
  editorRoot.dataset.readonly = 'false'
  editorRoot.setAttribute('role', 'textbox')
  editorRoot.setAttribute('aria-multiline', 'true')
  editorRoot.setAttribute('aria-label', 'Document') // as P2's root (axe aria-input-field-name; P3 merge)
  editorRoot.tabIndex = 0
  editorRoot.style.position = 'relative'
  host.appendChild(editorRoot)

  const toolbar = doc.createElement('div')
  toolbar.dataset.testid = 'mdr-toolbar'
  toolbar.className = 'mdr-fake-toolbar'
  const pill = doc.createElement('button')
  pill.type = 'button'
  pill.dataset.testid = 'mdr-mode-pill'
  pill.dataset.mode = mode
  pill.textContent = 'Editing'
  toolbar.appendChild(pill)
  toolbarHost.appendChild(toolbar)

  // ------------------------------------------------------------------ model layout

  const model = new WeakMap<Element, { top: number; height: number; left: number; width: number }>()
  function installRect(el: HTMLElement, top: number, height: number, left = 0, width = 600): void {
    model.set(el, { top, height, left, width })
    if (layoutMode !== 'model') return
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const m = model.get(el)!
        const c = sc.getBoundingClientRect()
        const t = c.top + sc.clientTop + m.top - sc.scrollTop
        const l = c.left + sc.clientLeft + m.left - sc.scrollLeft
        return { top: t, bottom: t + m.height, left: l, right: l + m.width, width: m.width, height: m.height, x: l, y: t, toJSON: () => ({}) } as DOMRect
      },
    })
  }

  const contentRect = (r: { top: number; bottom: number; left: number }): Rect => {
    const c = sc.getBoundingClientRect()
    return {
      top: r.top - c.top + sc.scrollTop - sc.clientTop,
      bottom: r.bottom - c.top + sc.scrollTop - sc.clientTop,
      left: r.left - c.left + sc.scrollLeft - sc.clientLeft,
    }
  }
  const rectOfEl = (el: Element): Rect => contentRect(el.getBoundingClientRect())

  // ------------------------------------------------------------------ rendering

  let blocks: ViewBlock[] = []
  const blockEls: HTMLElement[] = []

  function threadsToShow(): Thread[] {
    const rv = session.getReview()
    return rv.threads.filter((t) => !t.detached && t.anchor.kind !== 'doc' && (visible ? visible.has(t.id) : t.status === 'open'))
  }

  function findQuote(text: string, quote: string, from = 0): number {
    if (!quote) return -1
    return text.indexOf(quote, from)
  }

  function spansFor(b: ViewBlock, threads: Thread[], suggestions: Suggestion[]): Span[] {
    const spans: Span[] = []
    for (const t of threads) {
      const a = t.anchor
      if (a.kind === 'block') {
        if (a.hint.blockHash === b.hash || (b.hash === ZERO16 && a.hint.block === b.index)) spans.push({ start: 0, end: b.text.length, kind: 'hl', thread: t.id })
        continue
      }
      if (a.kind !== 'text') continue
      const at = findQuote(b.text, a.quote)
      if (at < 0) continue
      const hinted = a.hint.block === b.index || a.hint.blockHash === b.hash
      const elsewhere = blocks.some((x) => x !== b && (x.index === a.hint.block || x.hash === a.hint.blockHash) && findQuote(x.text, a.quote) >= 0)
      if (!hinted && elsewhere) continue
      spans.push({ start: at, end: at + (a.tail !== undefined ? Math.max(a.quote.length, 1) : a.quote.length), kind: 'hl', thread: t.id })
    }
    for (const s of suggestions) {
      const h = s.hunks[0]
      if (!h) continue
      const inRun = s.located ? b.index >= s.located.start && b.index < s.located.end : b.index >= s.range.start && b.index < s.range.end
      if (!inRun && !(h.del && b.text.includes(h.del))) continue
      if (h.del) {
        const at = b.text.indexOf(h.del)
        if (at < 0) continue
        spans.push({ start: at, end: at + h.del.length, kind: 'del', suggestion: s.id, by: s.by, ...(h.ins ? { insText: h.ins } : {}) })
      } else if (h.ins) {
        spans.push({ start: b.text.length, end: b.text.length, kind: 'ins', suggestion: s.id, by: s.by, insText: h.ins })
      }
      placed.add(s.id)
    }
    spans.sort((x, y) => x.start - y.start || (x.kind === 'hl' ? -1 : 1))
    const out: Span[] = []
    let end = -1
    for (const sp of spans) {
      if (sp.start < end) continue
      out.push(sp)
      end = Math.max(end, sp.end)
    }
    return out
  }

  function render(reason: LayoutReason = 'doc'): void {
    const snap = session.getSnapshot()
    const rv = session.getReview()
    blocks = viewBlocks(snap)
    placed.clear()
    editorRoot.innerHTML = ''
    blockEls.length = 0
    const threads = threadsToShow()
    const suggestions = rv.suggestions.filter((s) => s.status === 'pending' || s.status === 'stale')
    const conflicts = session.getConflicts()
    let y = topPadding
    for (const b of blocks) {
      for (const px of spacers.get(b.index) ?? []) {
        const sp = doc.createElement('div')
        sp.className = 'mdr-fake-spacer'
        sp.style.height = `${px}px`
        sp.style.margin = '0'
        editorRoot.appendChild(sp)
        installRect(sp, y, px)
        y += px
      }
      const el = doc.createElement('div')
      el.className = 'mdr-fake-block'
      el.dataset.block = String(b.index)
      el.dataset.hash = b.hash
      el.style.whiteSpace = 'pre-wrap'
      el.style.lineHeight = `${lineHeight}px`
      el.style.margin = `0 0 ${blockGap}px 0`
      el.style.minHeight = `${lineHeight}px`
      const c = conflicts.find((x) => [x.mine, x.theirs, x.base].some((t) => t && (b.source.includes(t.split(/\r?\n/)[0]!) || t.includes(b.source))))
      if (c) {
        el.dataset.testid = 'mdr-conflict-block'
        el.dataset.conflict = c.id
        el.dataset.kind = c.kind
      }
      if (isAtom(b)) el.dataset.atom = b.kind
      const lines = Math.max(1, b.text.split('\n').length)
      const height = lines * lineHeight
      installRect(el, y, height)
      const spans = spansFor(b, threads, suggestions)
      let pos = 0
      const lineTop = (offset: number): number => y + (b.text.slice(0, offset).split('\n').length - 1) * lineHeight
      for (const sp of spans) {
        if (sp.start > pos) el.appendChild(doc.createTextNode(b.text.slice(pos, sp.start)))
        if (sp.kind === 'hl') {
          const hl = doc.createElement('span')
          hl.className = 'mdr-fake-hl'
          hl.dataset.testid = 'mdr-highlight'
          hl.dataset.thread = sp.thread!
          hl.dataset.active = String(activeThread === sp.thread)
          hl.textContent = b.text.slice(sp.start, sp.end) || '​'
          hl.addEventListener('click', () => {
            for (const cb of [...hlSubs]) cb(sp.thread!)
          })
          el.appendChild(hl)
          installRect(hl, lineTop(sp.start), lineHeight, 0, 200)
        } else {
          if (sp.kind === 'del') {
            const del = doc.createElement('del')
            del.dataset.testid = 'mdr-suggestion'
            del.dataset.suggestion = sp.suggestion!
            del.dataset.kind = 'del'
            del.dataset.by = sp.by!
            del.textContent = b.text.slice(sp.start, sp.end)
            el.appendChild(del)
            installRect(del, lineTop(sp.start), lineHeight, 0, 200)
          }
          if (sp.insText) {
            const ins = doc.createElement('ins')
            ins.dataset.testid = 'mdr-suggestion'
            ins.dataset.suggestion = sp.suggestion!
            ins.dataset.kind = 'ins'
            ins.dataset.by = sp.by!
            ins.textContent = sp.insText
            el.appendChild(ins)
            installRect(ins, lineTop(sp.end), lineHeight, 0, 200)
          }
        }
        pos = sp.end
      }
      if (pos < b.text.length || b.text.length === 0) el.appendChild(doc.createTextNode(b.text.slice(pos) || '​'))
      editorRoot.appendChild(el)
      blockEls.push(el)
      y += height + blockGap
    }
    if (layoutMode === 'model') {
      editorRoot.style.minHeight = `${y}px`
      installRect(editorRoot, 0, y)
    }
    fire(reason)
  }

  // ------------------------------------------------------------------ selection

  function blockIndexOf(node: Node | null): number | null {
    let n: Node | null = node
    while (n && n !== editorRoot) {
      if (n instanceof win!.HTMLElement && n.dataset.block !== undefined) return Number(n.dataset.block)
      n = n.parentNode
    }
    return null
  }

  function textAnchorFor(b: ViewBlock, quote: string, offsetInBlock: number): TextAnchor {
    const snap = session.getSnapshot()
    const info = snap.blocks[b.index]
    const pos = (info?.pStart ?? 0) + offsetInBlock
    const prefix = b.text.slice(Math.max(0, offsetInBlock - CONSTANTS.ANCHOR_CONTEXT_CHARS), offsetInBlock)
    const suffix = b.text.slice(offsetInBlock + quote.length, offsetInBlock + quote.length + CONSTANTS.ANCHOR_CONTEXT_CHARS)
    const hint = { rev: snap.rev, pos, block: b.index, blockHash: info?.hash ?? b.hash, offsetInBlock }
    if (quote.length > CONSTANTS.MAX_QUOTE_CHARS) {
      const e = CONSTANTS.LONG_QUOTE_EDGE_CHARS
      return { kind: 'text', quote: quote.slice(0, e), tail: quote.slice(quote.length - e), span: quote.length, prefix, suffix, hint }
    }
    return { kind: 'text', quote, prefix, suffix, hint }
  }

  function liveSelection(opt?: { collapsed?: 'none' | 'word' }): SelectionTarget {
    const sel = doc.getSelection?.()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0).cloneRange()
    if (!editorRoot.contains(range.commonAncestorContainer)) return null
    if (range.collapsed) {
      if (opt?.collapsed !== 'word') return null
      const node = range.startContainer
      const text = node.textContent ?? ''
      let a = range.startOffset
      let z = range.startOffset
      while (a > 0 && /\w/.test(text[a - 1]!)) a--
      while (z < text.length && /\w/.test(text[z]!)) z++
      if (a === z) return null
      range.setStart(node, a)
      range.setEnd(node, z)
    }
    const startEl = range.startContainer.parentElement
    const ins = startEl?.closest('ins[data-testid="mdr-suggestion"]') as HTMLElement | null
    const bi = blockIndexOf(range.startContainer)
    if (bi === null) return null
    const b = blocks.find((x) => x.index === bi)
    if (!b) return null
    const blockEl = blockEls[blocks.indexOf(b)]!
    const r = layoutMode === 'model' ? rectOfEl(blockEl) : contentRect(range.getBoundingClientRect())
    const extent = { top: r.top, bottom: Math.max(r.bottom, r.top + lineHeight) }
    if (ins) {
      const sid = ins.dataset.suggestion as SuggestionId
      const s = session.getReview().suggestions.find((x) => x.id === sid)
      if (s) return { kind: 'inside-suggestion', suggestion: sid, thread: s.thread, rect: r, extent }
    }
    if (isAtom(b)) {
      const snap = session.getSnapshot()
      const info = snap.blocks[b.index]
      const anchor: BlockAnchor = {
        kind: 'block',
        hint: { rev: snap.rev, block: b.index, blockHash: info?.hash ?? b.hash, kind: info?.kind ?? 'raw', mdType: info?.mdType ?? b.mdType },
        preview: (info?.preview ?? b.source).slice(0, 80),
      }
      return { kind: 'block', anchor, rect: r, extent }
    }
    const raw = range.toString()
    const quote = raw.trim()
    if (!quote) return null
    const lead = raw.length - raw.trimStart().length
    let offset = b.text.indexOf(quote)
    // prefer the occurrence at the DOM offset when the quote repeats
    const pre = doc.createRange()
    pre.setStart(blockEl, 0)
    pre.setEnd(range.startContainer, range.startOffset)
    const domOffset = pre.toString().replace(/​/g, '').length + lead
    if (b.text.slice(domOffset, domOffset + quote.length) === quote) offset = domOffset
    if (offset < 0) offset = 0
    return { kind: 'anchor', anchor: textAnchorFor(b, quote, offset), quote, rect: r, extent }
  }

  // ------------------------------------------------------------------ listeners

  const offSession = session.subscribe((what) => {
    if (what === 'doc') render('doc')
    else if (what === 'review' || what === 'conflicts') render('decorations')
  })
  const onSelChange = (): void => {
    const sel = doc.getSelection?.()
    if (sel && sel.rangeCount && editorRoot.contains(sel.getRangeAt(0).commonAncestorContainer)) for (const cb of [...selSubs]) cb()
  }
  doc.addEventListener('selectionchange', onSelChange)
  const onKey = (e: KeyboardEvent): void => {
    const k = keyOf(e)
    for (let i = shortcuts.length - 1; i >= 0; i--) {
      const b = shortcuts[i]!
      if (normBinding(b.key) !== k) continue
      if (b.run()) {
        e.preventDefault()
        return
      }
    }
  }
  editorRoot.addEventListener('keydown', onKey)
  const onResize = (): void => fire('resize')
  win?.addEventListener('resize', onResize)
  pill.addEventListener('click', () => bridge.setMode(mode === 'editing' ? 'suggesting' : 'editing'))

  // ------------------------------------------------------------------ the bridge

  const pendingIds = (sel?: { by?: Author; ids?: readonly SuggestionId[] }): SuggestionId[] =>
    session.getReview().suggestions
      .filter((s) => s.status === 'pending' && (!sel?.by || s.by === sel.by) && (!sel?.ids || sel.ids.includes(s.id)))
      .map((s) => s.id)

  const bridge: FakeEditorBridge = {
    shortcuts,
    calls,
    layoutMode,
    getMode: () => mode,
    setMode(m) {
      call('setMode', m)
      if (m === mode) return
      mode = m
      editorRoot.dataset.mode = m
      pill.dataset.mode = m
      pill.textContent = m === 'editing' ? 'Editing' : 'Suggesting'
      for (const cb of [...modeSubs]) cb(m)
      fire('mode')
    },
    onModeChange(cb) {
      modeSubs.add(cb)
      return () => modeSubs.delete(cb)
    },
    getAnchorRects(ids) {
      const out = new Map<string, AnchorRect | null>()
      const rv = session.getReview()
      for (const id of ids) {
        let el: Element | null = null
        if (id.startsWith('conflict:') || id.startsWith('unsaveable:')) {
          el = editorRoot.querySelector(`[data-testid="mdr-conflict-block"][data-conflict="${id}"]`)
        } else {
          el = editorRoot.querySelector(`[data-testid="mdr-highlight"][data-thread="${id}"]`)
          if (!el) {
            const t = rv.threads.find((x) => x.id === id)
            for (const sid of t?.suggestions ?? []) {
              el = editorRoot.querySelector(`[data-testid="mdr-suggestion"][data-suggestion="${sid}"]`)
              if (el) break
            }
          }
        }
        out.set(id, el ? rectOfEl(el) : null)
      }
      return out
    },
    onLayoutInvalidated(cb) {
      layoutSubs.add(cb)
      return () => layoutSubs.delete(cb)
    },
    getSelectionTarget(opt) {
      call('getSelectionTarget', opt)
      return scriptedSelection !== undefined ? scriptedSelection : liveSelection(opt)
    },
    onSelectionChange(cb) {
      selSubs.add(cb)
      return () => selSubs.delete(cb)
    },
    setVisibleThreads(ids) {
      call('setVisibleThreads', ids)
      visible = new Set(ids)
      render('decorations')
    },
    setActiveThread(id) {
      call('setActiveThread', id)
      activeThread = id
      for (const el of Array.from(editorRoot.querySelectorAll<HTMLElement>('[data-testid="mdr-highlight"]'))) {
        el.dataset.active = String(el.dataset.thread === id)
        el.classList.toggle('is-active', el.dataset.thread === id)
      }
    },
    setDraftHighlight(on) {
      call('setDraftHighlight', on)
    },
    onHighlightClick(cb) {
      hlSubs.add(cb)
      return () => hlSubs.delete(cb)
    },
    scrollToThread(id, opts) {
      call('scrollToThread', id, opts)
      const r = bridge.getAnchorRects([id]).get(id)
      if (!r) return
      const align = opts?.align ?? 'top30'
      if (align === 'nearest') {
        const top = sc.scrollTop
        const bottom = top + sc.clientHeight
        if (r.top >= top && r.bottom <= bottom) return
        sc.scrollTop = r.top < top ? r.top : r.bottom - sc.clientHeight
      } else sc.scrollTop = Math.max(0, r.top - sc.clientHeight * 0.3)
    },
    async accept(id) {
      call('accept', id)
      if (scriptedDecision) return scriptedDecision
      if (typeof session.decide !== 'function') return { ok: false, code: 'INTERNAL' }
      const r = await session.decide(id, 'accept')
      return r.ok ? { ok: true } : { ok: false, code: (r.code ?? 'INTERNAL') as ErrorCode }
    },
    async reject(id) {
      call('reject', id)
      if (scriptedDecision) return scriptedDecision
      if (typeof session.decide !== 'function') return { ok: false, code: 'INTERNAL' }
      const r = await session.decide(id, 'reject')
      return r.ok ? { ok: true } : { ok: false, code: (r.code ?? 'INTERNAL') as ErrorCode }
    },
    async acceptAll(sel): Promise<BulkDecisionResult | null> {
      call('acceptAll', sel)
      const ids = pendingIds(sel)
      if (!ids.length || typeof session.decideMany !== 'function') return null
      return session.decideMany(ids, 'accept')
    },
    async rejectAll(sel): Promise<BulkDecisionResult | null> {
      call('rejectAll', sel)
      const ids = pendingIds(sel)
      if (!ids.length || typeof session.decideMany !== 'function') return null
      return session.decideMany(ids, 'reject')
    },
    getSuggestionSummaries() {
      if (scriptedSummaries) return new Map(scriptedSummaries)
      const out = new Map<SuggestionId, SuggestionSummary>()
      for (const s of session.getReview().suggestions) {
        if (s.status !== 'pending' && s.status !== 'stale') continue
        const del = s.hunks.map((h) => h.del).join('')
        const ins = s.hunks.map((h) => h.ins).join('')
        const kind: SuggestionSummary['kind'] = del && ins ? (del === ins ? 'format' : 'replace') : del ? 'delete' : ins ? 'insert' : 'structure'
        const isPlaced = placed.has(s.id)
        out.set(s.id, {
          id: s.id, by: s.by, kind, deletedText: del, insertedText: ins, hunkCount: s.hunks.length, placed: isPlaced,
          ...(isPlaced ? {} : { unplaced: 'BASE_NOT_FOUND' as const }),
        })
      }
      return out
    },
    async resolveConflict(id, choice) {
      call('resolveConflict', id, choice)
      if (typeof session.dropConflict === 'function') session.dropConflict(id as BlockConflict['id'])
    },
    focusEditor(o) {
      call('focusEditor', ...(o ? [o] : []))
      editorRoot.focus()
    },
    onNotice(cb) {
      noticeSubs.add(cb)
      return () => noticeSubs.delete(cb)
    },
    registerShortcut(b): Unsubscribe {
      shortcuts.push(b)
      return () => {
        const i = shortcuts.indexOf(b)
        if (i >= 0) shortcuts.splice(i, 1)
      }
    },
    onTypingActivity(cb) {
      typingSubs.add(cb)
      return () => typingSubs.delete(cb)
    },

    setSelectionTarget(t) {
      scriptedSelection = t
      for (const cb of [...selSubs]) cb()
    },
    setSuggestionSummaries(m) {
      scriptedSummaries = m
    },
    setDecisionResult(r) {
      scriptedDecision = r
    },
    emitNotice(n) {
      for (const cb of [...noticeSubs]) cb(n)
    },
    emitTyping(b) {
      for (const cb of [...typingSubs]) cb(b)
    },
    emitHighlightClick(t) {
      for (const cb of [...hlSubs]) cb(t)
    },
    emitLayout(r) {
      fire(r)
    },
    insertBlockAbove(id, px) {
      call('insertBlockAbove', id, px)
      const hl = editorRoot.querySelector(`[data-testid="mdr-highlight"][data-thread="${id}"]`)
      const bi = hl ? blockIndexOf(hl) : null
      if (bi === null) throw new Error(`insertBlockAbove: no highlight for ${id}`)
      const list = spacers.get(bi) ?? []
      list.push(px)
      spacers.set(bi, list)
      render('doc')
    },
    render: () => render('decorations'),
    blockElements: () => [...blockEls],
  }

  render('reload')

  return {
    bridge,
    destroy() {
      offSession()
      doc.removeEventListener('selectionchange', onSelChange)
      editorRoot.removeEventListener('keydown', onKey)
      win?.removeEventListener('resize', onResize)
      for (const s of [modeSubs, layoutSubs, selSubs, hlSubs, noticeSubs, typingSubs]) (s as Set<unknown>).clear()
      host.innerHTML = ''
      toolbarHost.innerHTML = ''
    },
  }
}
