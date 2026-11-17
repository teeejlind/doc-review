// web/src/editor/linkPopover.ts (P2). The Cmd+K / toolbar link popover (CONTRACTS §12.13 "Links", §12.15).
//
// data-testid="mdr-link-popover", anchored under the selection inside #mdr-editor-host.
// - Edit mode: a URL field (prefilled when the selection is already a link), plus a text field when the selection is
//   empty. Enter applies, Esc cancels, an empty URL removes the link. Actions apply / cancel (and remove for a link).
// - View mode (the caret inside an existing link, or a click on one): the URL with Edit, Remove and Open
//   (window.open(url, '_blank', 'noopener')).
// Only http:, https:, mailto:, relative paths and #fragments are accepted; javascript:, data: and any other scheme
// are refused with an inline error. Every change is an ordinary user transaction, so in Suggesting mode adding,
// changing or removing a link is a tracked format suggestion.
import type { Mark, MarkType, Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { ReplaceStep } from '@milkdown/kit/prose/transform'
import type { EditorView } from '@milkdown/kit/prose/view'
import { TESTID } from '../../../shared/constants'
import { Popover, type PopoverAnchor, type PopoverSlot } from './popover'

export function linkAllowed(url: string): boolean {
  const u = url.trim()
  if (!u) return true
  if (/^(https?:|mailto:)/i.test(u)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return false // javascript:, data:, anything else with a scheme
  return true // relative paths, protocol-relative web links and #fragments
}

const TLDS = 'com|org|net|io|co|ai|dev|app|gov|edu|us|uk|de|fr|es|ca|au|me|xyz|info|biz|tv|so|to|ly|cc|fm|sh|gg'

/**
 * What TJ typed, made into a link target: a bare domain (example.com/page, www.…) gets https://, an email address gets
 * mailto:, and anything else (a scheme, #section, /path, ./file.md, notes.md) is left as typed. A target the editor
 * would otherwise save as a dead relative link is the case this exists for.
 */
export function normalizeLinkInput(input: string): string {
  const u = input.trim()
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || /^[#/?.]/.test(u)) return u
  if (/^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i.test(u)) return `mailto:${u}`
  if (new RegExp(`^(www\\.)?([a-z0-9-]+\\.)+(${TLDS})(:\\d+)?([/?#].*)?$`, 'i').test(u)) return `https://${u}`
  return u
}

/**
 * What is wrong with a link address the user typed (after normalizeLinkInput), in plain words, or null when it is fine:
 * an empty one (removes the link), http(s) with a host, mailto:, a relative path or a #section. A bare word like
 * "example" or a phrase like "hello world" is none of those, and saved as a dead relative link (Pass 4 #20).
 */
export function linkProblem(href: string): string | null {
  if (!href) return null
  if (!linkAllowed(href)) return 'Only web, mailto, relative and #section links are allowed.'
  const ask = 'Enter a web address, like example.com.'
  if (/\s/.test(href)) return ask
  if (/^https?:/i.test(href)) return /^https?:\/\/[^\s/?#]+/i.test(href) ? null : ask
  if (/^mailto:/i.test(href)) return /^mailto:\S+/i.test(href) ? null : ask
  // a path (./notes.md, ../up, /top, docs/plan, notes.md) or a #section / ?query; one bare word is none of them
  return /^[#/?.]/.test(href) || /[/.]/.test(href) ? null : ask
}

/**
 * Text typed at either edge of a link is not part of the link (the link mark is inclusive in the schema, so typing at
 * its end used to grow it, and typing at the start of a paragraph that opens with a link too). Inside a link nothing
 * changes. The new text just doesn't carry the link: no extra step, so Suggesting mode tracks a plain insertion.
 */
export function linkBoundaryPlugin(): Plugin<LinkTyping | null> {
  return new Plugin<LinkTyping | null>({
    key: linkTypingKey,
    state: {
      init: () => null,
      apply: (tr, prev, _old, next) => {
        const m = tr.getMeta(linkTypingKey) as LinkTyping | null | undefined
        if (m !== undefined) return m
        // the end of a link's text edited away with the caret left at that end starts a run too: typing "t" over a
        // selected "the primer" can reach us from the browser's DOM diff as "delete 'he primer'" (the first letters
        // match), so the first key never comes through handleTextInput; Backspace at a link's end is the same case
        const started = startedAtLinkEnd(tr, next)
        if (started) return started
        // any other edit or caret move ends a run of typing
        return prev && !tr.docChanged && !tr.selectionSet ? prev : null
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        const link = view.state.schema.marks.link
        if (!link) return false
        const st = view.state
        const $p = st.doc.resolve(from)
        const insert = (marks: readonly Mark[], typing: LinkTyping | null): true => {
          view.dispatch(st.tr.setStoredMarks(marks).insertText(text, from, to).setMeta(linkTypingKey, typing).scrollIntoView())
          return true
        }
        if (from !== to) {
          // typing over a selection inside one link (renaming it): the new text is that link's text (QA3)
          const m = sameLinkAcross(st.doc, from, to, link)
          if (!m) return false
          const marks = [...(st.storedMarks ?? $p.marksAcross(st.doc.resolve(to)) ?? []).filter((mk) => mk.type !== link), m]
          return insert(m.addToSet(marks), { pos: from + text.length, link: m })
        }
        const before = $p.nodeBefore ? link.isInSet($p.nodeBefore.marks) : undefined
        const after = $p.nodeAfter ? link.isInSet($p.nodeAfter.marks) : undefined
        const typing = linkTypingKey.getState(st)
        const stored = st.storedMarks ? link.isInSet(st.storedMarks) : undefined
        // still typing a link's new text: right after the last typed character of it, or into a link whose text was
        // just deleted (the browser keeps its mark) -- not a caret placed at a link's edge
        const cont = typing && typing.pos === from && before?.eq(typing.link) ? typing.link : !before && !after && stored ? stored : null
        if (cont) return insert(cont.addToSet((st.storedMarks ?? $p.marks()).filter((mk) => mk.type !== link)), { pos: from + text.length, link: cont })
        if ((!before && !after) || (before && after && before.eq(after))) return false
        return insert((st.storedMarks ?? $p.marks()).filter((mk) => mk.type !== link), null)
      },
    },
  })
}

/** A run of typing that is a link's text: the position after the last typed character, and the link. */
interface LinkTyping { pos: number; link: Mark }
const linkTypingKey = new PluginKey<LinkTyping | null>('mdr-link-typing')

/** A user deletion of linked text that leaves the caret right after the rest of that link (not inside it), or null. */
function startedAtLinkEnd(tr: Transaction, next: EditorState): LinkTyping | null {
  const link = next.schema.marks.link
  if (!link || !tr.docChanged || tr.getMeta('history$') || !next.selection.empty) return null
  const removedLinked = tr.steps.some((st, i) => {
    const s = st as unknown as { from?: number; to?: number; slice?: { size: number } }
    return st instanceof ReplaceStep && s.from! < s.to! && tr.docs[i]!.rangeHasMark(s.from!, s.to!, link)
  })
  if (!removedLinked) return null
  const $p = next.selection.$from
  const before = $p.nodeBefore ? link.isInSet($p.nodeBefore.marks) : undefined
  const after = $p.nodeAfter ? link.isInSet($p.nodeAfter.marks) : undefined
  return before && !(after && after.eq(before)) ? { pos: $p.pos, link: before } : null
}

/** The one link mark that every inline node in [from, to) carries, or null. */
function sameLinkAcross(doc: PMNode, from: number, to: number, type: MarkType): Mark | null {
  let m: Mark | null = null
  let ok = true
  doc.nodesBetween(from, to, (n) => {
    if (!ok || !n.isInline) return ok
    const x = type.isInSet(n.marks)
    if (!x || (m && !m.eq(x))) ok = false
    else m ??= x
    return false
  })
  return ok ? m : null
}

/** The full extent of the link mark around `pos` (inclusive of both edges), or null. */
export function linkRange(view: EditorView, pos: number, type: MarkType): { from: number; to: number; mark: Mark } | null {
  const $p = view.state.doc.resolve(pos)
  const parent = $p.parent
  if (!parent.inlineContent) return null
  const start = $p.start()
  const runs: Array<{ from: number; to: number; mark: Mark }> = []
  let offset = 0
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i)
    const a = start + offset
    const b = a + child.nodeSize
    offset += child.nodeSize
    const m = type.isInSet(child.marks)
    const last = runs[runs.length - 1]
    if (m && last && last.to === a && last.mark.eq(m)) last.to = b
    else if (m) runs.push({ from: a, to: b, mark: m })
  }
  // strictly inside first, then at an edge (the caret right after a link still edits it)
  return runs.find((r) => r.from < pos && pos < r.to) ?? runs.find((r) => r.from <= pos && pos <= r.to) ?? null
}

export function openUrl(doc: Document, href: string): void {
  if (href && linkAllowed(href)) doc.defaultView?.open(href, '_blank', 'noopener')
}

export interface LinkPopoverHooks {
  host: HTMLElement
  slot: PopoverSlot
  view(): EditorView
  editable(): boolean
}

export class LinkPopover {
  constructor(private readonly h: LinkPopoverHooks) {}

  isOpen(): boolean {
    return this.h.slot.current?.el.dataset.testid === TESTID.linkPopover
  }

  close(refocus = true): void {
    if (this.isOpen()) this.h.slot.close(refocus)
  }

  /** Cmd+K / the toolbar button: view mode for a caret inside a link, edit mode otherwise. */
  open(): boolean {
    const view = this.h.view()
    const type = view.state.schema.marks.link
    if (!type || !this.h.editable()) return false
    const { from, empty } = view.state.selection
    const existing = linkRange(view, from, type)
    if (empty && existing && existing.from < from && from < existing.to) return this.openView(existing)
    return this.openEdit()
  }

  /**
   * A click on a link: view mode, with the caret left where the click put it, so typing, Backspace and arrows keep
   * editing the text, as in Google Docs (QA3: focus moved to the popover's Edit button and keystrokes were lost).
   */
  openAt(pos: number): boolean {
    const view = this.h.view()
    const type = view.state.schema.marks.link
    if (!type) return false
    const r = linkRange(view, pos, type)
    if (!r) return false
    return this.openView(r, false)
  }

  /** The caret moved or the text changed: a view popover opened by a click closes once the caret is out of its link. */
  caretMoved(): void {
    const cur = this.h.slot.current
    if (!cur || cur.el.dataset.testid !== TESTID.linkPopover || cur.el.dataset.mode !== 'view') return
    if (cur.el.contains(cur.el.ownerDocument.activeElement)) return
    const view = this.h.view()
    const type = view.state.schema.marks.link
    const { from, empty } = view.state.selection
    if (!type || !empty || !linkRange(view, from, type)) this.close(false)
  }

  private popover(): Popover {
    const p = new Popover({
      host: this.h.host,
      className: 'mdr-link-popover',
      testid: TESTID.linkPopover,
      label: 'Link',
      onClose: (refocus) => {
        if (refocus) this.h.view().focus()
      },
    })
    this.h.slot.set(p)
    return p
  }

  private coords(pos: number): PopoverAnchor | null {
    try {
      const c = this.h.view().coordsAtPos(pos)
      return { left: c.left, bottom: c.bottom, top: c.top }
    } catch {
      return null
    }
  }

  private openView(r: { from: number; to: number; mark: Mark }, focus = true): boolean {
    const p = this.popover()
    p.el.dataset.mode = 'view'
    const href = String(r.mark.attrs.href ?? '')
    const doc = this.h.host.ownerDocument
    const url = doc.createElement('a')
    url.className = 'mdr-popover__url'
    url.textContent = href
    url.href = linkAllowed(href) ? href : '#'
    url.addEventListener('click', (e) => {
      e.preventDefault()
      openUrl(doc, href)
    })
    p.el.appendChild(url)
    const ro = this.h.editable() ? null : 'This document is read-only.'
    p.action('edit', 'Edit', () => {
      if (this.h.editable()) this.openEdit({ from: r.from, to: r.to })
    }, { disabledReason: ro })
    p.action('remove', 'Remove', () => {
      if (!this.h.editable()) return
      const v = this.h.view()
      v.dispatch(v.state.tr.removeMark(r.from, r.to, v.state.schema.marks.link!))
      p.close(true)
    }, { disabledReason: ro })
    p.action('open', 'Open', () => {
      openUrl(doc, href)
      p.close(false)
    })
    p.open(this.coords(r.from), focus ? p.actions.querySelector('button') : null)
    return true
  }

  private openEdit(range?: { from: number; to: number }): boolean {
    const view = this.h.view()
    const type = view.state.schema.marks.link!
    const sel = view.state.selection
    const target = range ?? { from: sel.from, to: sel.to }
    const existing = linkRange(view, target.from, type)
    const covering = existing && existing.from <= target.from && target.to <= existing.to ? existing : null
    const p = this.popover()
    const url = p.field('url', { label: 'Link URL', placeholder: 'Paste or type a link', value: covering ? String(covering.mark.attrs.href ?? '') : '' })
    const text = target.from === target.to && !covering ? p.field('text', { label: 'Text to display', placeholder: 'Text to display', value: '' }) : null
    const apply = (): void => {
      const href = normalizeLinkInput(url.value)
      const problem = linkProblem(href)
      if (problem) {
        p.setError(problem)
        return
      }
      const v = this.h.view()
      let tr = v.state.tr
      const r = covering ? { from: covering.from, to: covering.to } : target
      if (!href) {
        if (covering) tr = tr.removeMark(covering.from, covering.to, type)
      } else if (r.from === r.to) {
        const label = text?.value || href
        tr = tr.insertText(label, r.from)
        tr = tr.addMark(r.from, r.from + label.length, type.create({ href, title: null }))
        tr = tr.setSelection(TextSelection.create(tr.doc, r.from + label.length))
      } else {
        tr = tr.removeMark(r.from, r.to, type).addMark(r.from, r.to, type.create({ href, title: null }))
      }
      if (tr.docChanged) v.dispatch(tr)
      p.close(true)
    }
    for (const f of [url, text]) {
      f?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          e.preventDefault()
          apply()
        }
      })
    }
    p.action('apply', 'Apply', apply, { primary: true })
    p.action('cancel', 'Cancel', () => p.close(true))
    if (covering) {
      p.action('remove', 'Remove', () => {
        const v = this.h.view()
        v.dispatch(v.state.tr.removeMark(covering.from, covering.to, type))
        p.close(true)
      })
    }
    p.open(this.coords(target.from), url)
    return true
  }
}
