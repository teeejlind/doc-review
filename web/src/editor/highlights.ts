// web/src/editor/highlights.ts (P2). The comment highlight plugin (CONTRACTS §12.1, §5.4, §12.15) and the
// conflict / unsaveable block decorations (§7.4).
//
// Highlights: inline decorations class="hl hl--tj|claude [is-active] [hl--resolved]" with data-thread, and for tests
// data-testid="mdr-highlight" plus data-active; node decorations for block anchors. The places are mapped through
// every transaction (start sticks after text typed at it, end before), and the decoration set is rebuilt from them,
// so the live mapped range is the truth for TJ's edits. A range that collapses to empty is a genuine deletion: the
// next save detaches the thread (§5.4). resolveAnchor runs only when places are (re)set: load, reload, hydrate.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { ReplaceStep } from '@milkdown/kit/prose/transform'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Author, BlockConflict, ThreadId } from '../../../shared/types'
import { TESTID } from '../../../shared/constants'

export type ThreadPlace =
  /** `growing`: the whole highlight was just typed over; text typed right at its end belongs to it until the caret moves on. */
  | { kind: 'text'; from: number; to: number; growing?: boolean }
  | { kind: 'block'; pos: number; collapsed?: boolean }

export interface HighlightState {
  places: Map<ThreadId, ThreadPlace>
  authors: Map<ThreadId, Author>
  resolved: ReadonlySet<ThreadId>
  /** null = the default set (every open comment thread), until P3 calls setVisibleThreads. */
  visible: ReadonlySet<ThreadId> | null
  active: string | null
  decos: DecorationSet
}

export type HighlightMeta =
  | { put: Map<ThreadId, ThreadPlace>; replace?: boolean }
  | { remove: ThreadId[] }
  | { visible: ReadonlySet<ThreadId> | null }
  | { active: string | null }
  | { authors: Map<ThreadId, Author>; resolved: ReadonlySet<ThreadId> }

export const highlightKey = new PluginKey<HighlightState>('mdr-highlights')

export function isCollapsed(p: ThreadPlace): boolean {
  return p.kind === 'text' ? p.to <= p.from : p.collapsed === true
}

/** The place of the text a new-comment box is open on: shown like a highlight, but it is no thread (no data-thread, no test id). */
export const DRAFT_PLACE = 't_draft' as ThreadId

function build(doc: PMNode, s: Omit<HighlightState, 'decos'>): DecorationSet {
  const decos: Decoration[] = []
  for (const [id, p] of s.places) {
    if (isCollapsed(p)) continue
    if (id === DRAFT_PLACE) {
      if (p.kind === 'text' && p.from >= 0 && p.to <= doc.content.size) {
        decos.push(Decoration.inline(p.from, p.to, { class: 'hl hl--tj hl-draft is-active', 'data-draft-highlight': 'true' }, { inclusiveStart: false, inclusiveEnd: false }))
      }
      continue
    }
    const shown = s.visible ? s.visible.has(id) : !s.resolved.has(id)
    if (!shown) continue
    const active = s.active === id
    const author = s.authors.get(id) === 'Claude' ? 'claude' : 'tj'
    const cls = `hl hl--${author}${active ? ' is-active' : ''}${s.resolved.has(id) ? ' hl--resolved' : ''}`
    const attrs = { class: cls, 'data-thread': id, 'data-testid': TESTID.highlight, 'data-active': String(active) }
    if (p.kind === 'text') {
      if (p.from < 0 || p.to > doc.content.size) continue
      decos.push(Decoration.inline(p.from, p.to, attrs, { inclusiveStart: false, inclusiveEnd: false, thread: id }))
    } else {
      const n = doc.nodeAt(p.pos)
      if (!n) continue
      decos.push(Decoration.node(p.pos, p.pos + n.nodeSize, { ...attrs, class: `${cls} hl-block` }, { thread: id }))
    }
  }
  return DecorationSet.create(doc, decos)
}

function mapPlaces(places: Map<ThreadId, ThreadPlace>, tr: Transaction): Map<ThreadId, ThreadPlace> {
  const out = new Map<ThreadId, ThreadPlace>()
  for (const [id, p] of places) {
    if (p.kind === 'text') {
      if (p.to <= p.from) {
        out.set(id, p)
        continue
      }
      const step = tr.steps.length === 1 ? tr.steps[0] : null
      const rs = step instanceof ReplaceStep ? (step as unknown as { from: number; to: number; slice: { size: number } }) : null
      // typed over the whole highlight (a selection replaced by its first character): the characters that follow, typed
      // at its end, are part of the replacement, so the highlight keeps growing until the caret leaves it
      const replacedAll = !!rs && rs.slice.size > 0 && rs.from <= p.from && rs.to >= p.to
      const extending = p.growing === true && !!rs && rs.from === rs.to && rs.from === p.to && rs.slice.size > 0
      const from = tr.mapping.map(p.from, 1)
      const to = tr.mapping.map(p.to, extending ? 1 : -1)
      out.set(id, { kind: 'text', from, to: Math.max(from, to), ...(replacedAll || extending ? { growing: true } : {}) })
    } else {
      const r = tr.mapping.mapResult(p.pos, 1)
      const n = r.deleted ? null : tr.doc.nodeAt(r.pos)
      out.set(id, { kind: 'block', pos: r.pos, collapsed: p.collapsed === true || r.deleted || !n })
    }
  }
  return out
}

export function highlightPlugin(): Plugin<HighlightState> {
  return new Plugin<HighlightState>({
    key: highlightKey,
    state: {
      init: (_c, state: EditorState) => ({
        places: new Map(), authors: new Map(), resolved: new Set(), visible: null, active: null, decos: DecorationSet.create(state.doc, []),
      }),
      apply(tr, s, _old, state) {
        const meta = tr.getMeta(highlightKey) as HighlightMeta | undefined
        if (!meta && !tr.docChanged) {
          // the caret leaving the end of a highlight that is growing ends the replacement
          if (!tr.selectionSet) return s
          let stale = false
          const places = new Map(s.places)
          for (const [id, p] of s.places) {
            if (p.kind === 'text' && p.growing && state.selection.head !== p.to) {
              places.set(id, { kind: 'text', from: p.from, to: p.to })
              stale = true
            }
          }
          return stale ? { ...s, places } : s
        }
        let next: Omit<HighlightState, 'decos'> = { ...s }
        if (tr.docChanged) next.places = mapPlaces(s.places, tr)
        if (meta) {
          if ('put' in meta) {
            const places = meta.replace ? new Map<ThreadId, ThreadPlace>() : new Map(next.places)
            for (const [id, p] of meta.put) places.set(id, p)
            next = { ...next, places }
          } else if ('remove' in meta) {
            const places = new Map(next.places)
            for (const id of meta.remove) places.delete(id)
            next = { ...next, places }
          } else if ('visible' in meta) next = { ...next, visible: meta.visible }
          else if ('active' in meta) next = { ...next, active: meta.active }
          else next = { ...next, authors: meta.authors, resolved: meta.resolved }
        }
        return { ...next, decos: build(state.doc, next) }
      },
    },
    props: {
      decorations: (state) => highlightKey.getState(state)?.decos ?? DecorationSet.empty,
    },
  })
}

/** Threads whose live text range covers `pos` (innermost first). */
export function threadsAt(state: EditorState, pos: number): ThreadId[] {
  const s = highlightKey.getState(state)
  if (!s) return []
  const hits: Array<{ id: ThreadId; len: number }> = []
  for (const [id, p] of s.places) {
    if (isCollapsed(p)) continue
    const shown = s.visible ? s.visible.has(id) : !s.resolved.has(id)
    if (!shown) continue
    if (p.kind === 'text' && pos >= p.from && pos <= p.to) hits.push({ id, len: p.to - p.from })
    if (p.kind === 'block') {
      const n = state.doc.nodeAt(p.pos)
      if (n && pos >= p.pos && pos <= p.pos + n.nodeSize) hits.push({ id, len: n.nodeSize })
    }
  }
  return hits.sort((a, b) => a.len - b.len).map((h) => h.id)
}

// =====================================================================================================
// Conflict / unsaveable decorations (§7.4)
// =====================================================================================================

export interface ConflictPlace { id: BlockConflict['id']; kind: BlockConflict['kind']; pos: number }

interface ConflictState { places: ConflictPlace[]; decos: DecorationSet }

export const conflictKey = new PluginKey<ConflictState>('mdr-conflicts')

function buildConflicts(doc: PMNode, places: readonly ConflictPlace[]): DecorationSet {
  const decos: Decoration[] = []
  for (const c of places) {
    const n = doc.nodeAt(c.pos)
    if (!n) continue
    decos.push(Decoration.node(c.pos, c.pos + n.nodeSize, {
      class: `mdr-conflict mdr-conflict--${c.kind}`, 'data-testid': TESTID.conflictBlock, 'data-conflict': c.id, 'data-kind': c.kind,
    }))
  }
  return DecorationSet.create(doc, decos)
}

export function conflictPlugin(): Plugin<ConflictState> {
  return new Plugin<ConflictState>({
    key: conflictKey,
    state: {
      init: (_c, state: EditorState): ConflictState => ({ places: [], decos: DecorationSet.create(state.doc, []) }),
      apply(tr, s: ConflictState, _o, state): ConflictState {
        const meta = tr.getMeta(conflictKey) as ConflictPlace[] | undefined
        if (!meta && !tr.docChanged) return s
        let places: ConflictPlace[] = s.places
        if (tr.docChanged) {
          places = places.flatMap((c): ConflictPlace[] => {
            const r = tr.mapping.mapResult(c.pos, 1)
            return r.deleted ? [] : [{ ...c, pos: r.pos }]
          })
        }
        if (meta) places = meta
        return { places, decos: buildConflicts(state.doc, places) }
      },
    },
    props: { decorations: (state) => conflictKey.getState(state)?.decos ?? DecorationSet.empty },
  })
}

// =====================================================================================================
// Test spacers (test hooks only): a block of an exact height, for the editor-bridge contract's step 5 (§12.0.3)
// =====================================================================================================

export const spacerKey = new PluginKey<Array<{ pos: number; px: number }>>('mdr-test-spacers')

export function spacerPlugin(): Plugin<Array<{ pos: number; px: number }>> {
  return new Plugin<Array<{ pos: number; px: number }>>({
    key: spacerKey,
    state: {
      init: () => [],
      apply(tr, s) {
        const add = tr.getMeta(spacerKey) as { pos: number; px: number } | undefined
        let next = tr.docChanged ? s.map((x) => ({ ...x, pos: tr.mapping.map(x.pos, 1) })) : s
        if (add) next = [...next, add]
        return next
      },
    },
    props: {
      decorations(state) {
        const list = spacerKey.getState(state) ?? []
        if (!list.length) return DecorationSet.empty
        const decos: Decoration[] = []
        for (const x of list) {
          const n = state.doc.nodeAt(x.pos)
          if (n) decos.push(Decoration.node(x.pos, x.pos + n.nodeSize, { style: `height:${x.px}px;margin:0;padding:0;overflow:hidden;box-sizing:border-box`, 'data-mdr-spacer': '' }))
        }
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}
