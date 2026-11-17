// web/src/editor/paste/plugin.ts (P2). Paste wiring (CONTRACTS §12.11).
//
// - transformPastedHTML: normalizePasted (rules 1-6), with the page's URL from the clipboard's text/x-moz-url
//   (captured on the paste event) as the base for relative links; dropped images raise PASTE_IMAGE_DROPPED.
// - transformPasted: what the DOM parser can't express: images never carry a title (Milkdown's parseDOM falls back
//   to the alt text), and a table column without a source alignment is `---`, not `:--` (the cell parser defaults
//   to 'left').
// - handlePaste: Cmd+Shift+V inserts text/plain only (paragraphs split on blank lines, single newlines kept as soft
//   breaks); a lone URL pasted over a non-empty selection links the selection (rule 7).
// Every paste is one ordinary user transaction through the editor's dispatch, so in Suggesting mode it is tracked,
// and a pasted table, code block or rule is blocked by the D14 filter.
import { Fragment, Slice, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { EditorNotice } from '../../../../shared/types'
import { hasAddress, linkifiedText } from '../autolink'
import { normalizePasted } from './normalize'

export interface PasteHooks {
  notice(n: EditorNotice): void
  /** text/plain parsed as markdown into blocks (null when it can't be: the text is then pasted as typed). */
  markdown?(text: string): PMNode[] | null
  /** True while a Cmd+Shift+V plain paste is pending (consumed by the next paste). */
  takePlain(): boolean
}

export const pasteKey = new PluginKey('mdr-paste')

const LONE_URL = /^(?:https?:\/\/|mailto:)[^\s<>"]+$/i

/**
 * Is this plain text clearly markdown (what a terminal, a .md file or Slack puts on the clipboard)? Block markers at a
 * line start (heading, list, task, quote, fence, table row), or inline syntax that closes (**bold**, `code`, [text](url)).
 * A stray * or _ in ordinary prose doesn't count.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (/^ {0,3}(#{1,6} +\S|[-*+] +\S|\d{1,9}[.)] +\S|> ?\S|```|~~~|\|.+\|\s*$)/m.test(text)) return true
  return /\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|~~[^~\n]+~~/.test(text)
}

/**
 * text/plain as a slice: blank lines split paragraphs; single newlines are soft line breaks. `linkify`: addresses
 * become links (a plain paste, QA3), not with Cmd+Shift+V.
 */
export function plainTextSlice(schema: Schema, text: string, linkify = false): Slice {
  const para = schema.nodes.paragraph!
  const br = schema.nodes.hardbreak
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map((b) => b.replace(/^\n+|\n+$/g, ''))
  const nodes: PMNode[] = []
  for (const b of blocks) {
    if (!b) continue
    const inline: PMNode[] = []
    b.split('\n').forEach((line, i) => {
      if (i > 0 && br) inline.push(br.create({ isInline: true }))
      if (line) inline.push(...(linkify ? linkifiedText(schema, line) : [schema.text(line)]))
    })
    nodes.push(para.create(null, inline))
  }
  if (!nodes.length) return Slice.empty
  return new Slice(Fragment.from(nodes), 1, 1)
}

function mapNodes(frag: Fragment, f: (n: PMNode) => PMNode): Fragment {
  const out: PMNode[] = []
  frag.forEach((n) => {
    const kids = n.isLeaf ? n : n.copy(mapNodes(n.content, f))
    out.push(f(kids))
  })
  return Fragment.from(out)
}

export function fixPastedSlice(slice: Slice): Slice {
  let changed = false
  const content = mapNodes(slice.content, (n) => {
    if (n.type.name === 'image' && n.attrs.title) {
      changed = true
      return n.type.create({ ...n.attrs, title: '' }, n.content, n.marks)
    }
    if ((n.type.name === 'table_cell' || n.type.name === 'table_header') && n.attrs.alignment === 'left') {
      changed = true
      return n.type.create({ ...n.attrs, alignment: null }, n.content, n.marks)
    }
    return n
  })
  return changed ? new Slice(content, slice.openStart, slice.openEnd) : slice
}

export function pastePlugin(h: PasteHooks): Plugin {
  let sourceUrl: string | undefined
  /** Where the last pasted HTML came from: our own editor's clipboard HTML keeps its attrs as they are. */
  let lastSource: ReturnType<typeof normalizePasted>['source'] | null = null
  return new Plugin({
    key: pasteKey,
    props: {
      handleDOMEvents: {
        paste(_view, e) {
          const moz = (e as ClipboardEvent).clipboardData?.getData('text/x-moz-url') ?? ''
          const first = moz.split(/\r?\n/)[0]?.trim()
          sourceUrl = first && /^https?:/i.test(first) ? first : undefined
          lastSource = null
          return false
        },
      },
      transformPastedHTML(html: string) {
        const r = normalizePasted(html, sourceUrl ? { sourceUrl } : {})
        sourceUrl = undefined
        lastSource = r.source
        if (r.droppedImages > 0) {
          h.notice({
            kind: 'warn',
            code: 'PASTE_IMAGE_DROPPED',
            text: r.droppedImages === 1 ? "An embedded image couldn't be pasted (markdown needs a web address for images)." : `${r.droppedImages} embedded images couldn't be pasted (markdown needs a web address for images).`,
          })
        }
        return r.html
      },
      transformPasted(slice: Slice) {
        if (lastSource === 'pm' || lastSource === null) return slice
        return fixPastedSlice(slice)
      },
      handlePaste(view: EditorView, event: ClipboardEvent) {
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (h.takePlain()) {
          if (!text) return true
          const { $from } = view.state.selection
          if ($from.parent.type.spec.code) view.dispatch(view.state.tr.insertText(text.replace(/\r\n?/g, '\n')).scrollIntoView())
          else view.dispatch(view.state.tr.replaceSelection(plainTextSlice(view.state.schema, text)).scrollIntoView())
          return true
        }
        // text/plain alone that is clearly markdown: parse it into blocks (Cmd+Shift+V, above, keeps it literal)
        const types = Array.from(event.clipboardData?.types ?? [])
        if (text && h.markdown && !types.includes('text/html') && looksLikeMarkdown(text) && !view.state.selection.$from.parent.type.spec.code) {
          const nodes = h.markdown(text.replace(/\r\n?/g, '\n'))
          if (nodes && nodes.length) {
            // one paragraph goes in inline, at the caret; anything else lands as the blocks it is
            let slice: Slice
            if (nodes.length === 1 && nodes[0]!.type.name === 'paragraph') {
              // the parse trims the paragraph; spaces around the pasted words are the user's (mid-sentence paste)
              const { schema } = view.state
              const lead = /^[ \t]+/.exec(text)?.[0]
              const trail = /[ \t]+$/.exec(text)?.[0]
              slice = new Slice(Fragment.from([...(lead ? [schema.text(lead)] : []), ...nodes[0]!.content.content, ...(trail ? [schema.text(trail)] : [])]), 0, 0)
            } else slice = new Slice(Fragment.from(nodes), 0, 0)
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
            return true
          }
        }
        const url = text.trim()
        const link = view.state.schema.marks.link
        const { from, to, empty } = view.state.selection
        if (!empty && link && LONE_URL.test(url) && view.state.doc.resolve(from).sameParent(view.state.doc.resolve(to))) {
          const $f = view.state.doc.resolve(from)
          if (!$f.parent.inlineContent || $f.parent.type.spec.code) return false
          view.dispatch(view.state.tr.removeMark(from, to, link).addMark(from, to, link.create({ href: url, title: null })).scrollIntoView())
          return true
        }
        // plain text holding an address: pasted with the address linked, as Google Docs does (QA3)
        if (text && !types.includes('text/html') && !view.state.selection.$from.parent.type.spec.code && hasAddress(text)) {
          view.dispatch(view.state.tr.replaceSelection(plainTextSlice(view.state.schema, text, true)).scrollIntoView())
          return true
        }
        return false
      },
    },
  })
}
