// web/src/editor/commands.ts (P2). The formatting and block commands behind the toolbar and P2's keymap
// (CONTRACTS §12.13 toolbar, §11.5 P2 rows). Every command is an ordinary ProseMirror command, so in Suggesting mode
// its transaction goes through the editor's dispatch (foreign filter, D14, withSuggestChanges) like typing does.
import { Fragment, type MarkType, type Node as PMNode, type NodeType, type ResolvedPos, type Schema } from '@milkdown/kit/prose/model'
import { baseKeymap, exitCode, lift, setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from '@milkdown/kit/prose/schema-list'
import { EditorState, Selection, TextSelection, type Command, type Transaction } from '@milkdown/kit/prose/state'
import { goToNextCell } from '@milkdown/kit/prose/tables'
import { ZWSP } from '../../../core/suggest/guards'

const SUGGESTION_MARKS = new Set(['insertion', 'deletion', 'modification'])

export type ToolbarAction =
  | 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'heading' | 'heading-0' | 'heading-1' | 'heading-2' | 'heading-3'
  | 'bullet' | 'ordered' | 'task' | 'blockquote' | 'code-block' | 'hr' | 'undo' | 'redo'

const MARKS: Partial<Record<ToolbarAction, string>> = { bold: 'strong', italic: 'emphasis', strike: 'strike_through', code: 'inlineCode' }

function markType(schema: Schema, action: ToolbarAction): MarkType | null {
  const name = MARKS[action]
  return name ? (schema.marks[name] ?? null) : null
}

function ancestor($pos: ResolvedPos, name: string): { node: PMNode; depth: number; pos: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d)
    if (n.type.name === name) return { node: n, depth: d, pos: $pos.before(d) }
  }
  return null
}

/** The innermost list (bullet or ordered) around the selection start. */
function listAround($pos: ResolvedPos): { node: PMNode; depth: number; pos: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d)
    if (n.type.name === 'bullet_list' || n.type.name === 'ordered_list') return { node: n, depth: d, pos: $pos.before(d) }
  }
  return null
}

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks())
  return state.doc.rangeHasMark(from, to, type)
}

interface Span { from: number; to: number }

/**
 * Whether a mark is on all of the spans: nothing in them that could carry it is missing it. This is the test
 * toggleMark(…, { removeWhenPresent: false }) runs to choose between removing the mark and adding it, so a toolbar
 * button pressed for this answer is a button whose next press removes the mark. Blank text doesn't count against it.
 */
function fullyMarked(doc: PMNode, spans: readonly Span[], type: MarkType): boolean {
  let any = false
  const all = spans.every((r) => {
    let missing = false
    doc.nodesBetween(r.from, r.to, (n, pos, parent) => {
      if (missing) return false
      if (type.isInSet(n.marks)) any = true
      else missing = !!parent && parent.type.allowsMarkType(type) && !(n.isText && /^\s*$/.test(n.textBetween(Math.max(0, r.from - pos), Math.min(n.nodeSize, r.to - pos))))
    })
    return !missing
  })
  return all && any
}

/** A character a word is made of (apostrophes included, so "don't" is one word). */
const WORD_CHAR = /[\p{L}\p{N}_'’]/u

/**
 * The word a caret sits inside, when it has both a word character before it and one after it. At a word's edge there
 * is no word to format, and the mark is for the next typed text instead, as in Google Docs and Word (Pass 4 #32).
 */
function wordAroundCaret(state: EditorState, type: MarkType): Span | null {
  const { empty, $from } = state.selection
  const parent = $from.parent
  if (!empty || !parent.isTextblock || !parent.type.allowsMarkType(type)) return null
  const start = $from.start()
  const text = parent.textBetween(0, parent.content.size, undefined, '￼')
  const at = $from.parentOffset
  if (!WORD_CHAR.test(text[at - 1] ?? '') || !WORD_CHAR.test(text[at] ?? '')) return null
  let a = at
  let b = at
  while (a > 0 && WORD_CHAR.test(text[a - 1]!)) a--
  while (b < text.length && WORD_CHAR.test(text[b]!)) b++
  return { from: start + a, to: start + b }
}

/** The mark toggle as Google Docs does it: the word around a caret, all of a mixed selection, off only when all of it is on. */
function toggleFormat(type: MarkType): Command {
  const toggle = toggleMark(type, null, { removeWhenPresent: false })
  return (state, dispatch, view) => {
    const word = wordAroundCaret(state, type)
    if (!word) return toggle(state, dispatch, view)
    if (dispatch) {
      const tr = state.tr
      if (fullyMarked(state.doc, [word], type)) tr.removeMark(word.from, word.to, type)
      else tr.addMark(word.from, word.to, type.create())
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/** aria-pressed for a format button: on when pressing it would take the mark off (Google Docs shows mixed text as off). */
function formatPressed(state: EditorState, type: MarkType): boolean {
  const sel = state.selection
  if (sel.empty) {
    const word = wordAroundCaret(state, type)
    return word ? fullyMarked(state.doc, [word], type) : markActive(state, type)
  }
  return fullyMarked(state.doc, sel.ranges.map((r) => ({ from: r.$from.pos, to: r.$to.pos })), type)
}

/** aria-pressed for a toolbar action. */
export function actionActive(state: EditorState, action: ToolbarAction): boolean {
  const schema = state.schema
  const mt = markType(schema, action)
  if (mt) return formatPressed(state, mt)
  const $from = state.selection.$from
  const parent = $from.parent
  switch (action) {
    case 'link':
      return !!schema.marks.link && markActive(state, schema.marks.link)
    case 'heading':
      return parent.type.name === 'heading'
    case 'heading-0':
      return parent.type.name === 'paragraph'
    case 'heading-1':
    case 'heading-2':
    case 'heading-3':
      return parent.type.name === 'heading' && parent.attrs.level === Number(action.slice(-1))
    case 'bullet': {
      const l = listAround($from)
      const item = ancestor($from, 'list_item')
      return l?.node.type.name === 'bullet_list' && (item?.node.attrs.checked ?? null) === null
    }
    case 'ordered':
      return listAround($from)?.node.type.name === 'ordered_list'
    case 'task': {
      const item = ancestor($from, 'list_item')
      return !!item && item.node.attrs.checked !== null && item.node.attrs.checked !== undefined
    }
    case 'blockquote':
      return !!ancestor($from, 'blockquote')
    case 'code-block':
      return parent.type.name === 'code_block'
    default:
      return false
  }
}

const node = (schema: Schema, name: string): NodeType | null => schema.nodes[name] ?? null

/**
 * Why a toolbar action can't run here, or null. A table cell holds one line of inline text, so the block actions that
 * would wrap or retype it do nothing there; the toolbar shows them disabled with this as the reason (Pass 4 #27).
 */
export function actionBlockedReason(state: EditorState, action: ToolbarAction): string | null {
  if (!ancestor(state.selection.$from, 'table')) return null
  switch (action) {
    case 'bullet':
    case 'ordered':
    case 'task':
      return "A table cell can't hold a list."
    case 'blockquote':
      return "A table cell can't hold a quote."
    case 'code-block':
      return "A table cell can't hold a code block."
    case 'heading-1':
    case 'heading-2':
    case 'heading-3':
      return "A table cell can't hold a heading."
    default:
      return null
  }
}

/** Toggle a list type: lift out of the same list, convert a list of the other type, or wrap. */
function toggleList(listName: 'bullet_list' | 'ordered_list', task = false): Command {
  return (state, dispatch) => {
    const schema = state.schema
    const listType = node(schema, listName)
    const item = node(schema, 'list_item')
    if (!listType || !item) return false
    const $from = state.selection.$from
    const l = listAround($from)
    const li = ancestor($from, 'list_item')
    if (l && li) {
      const isTask = li.node.attrs.checked !== null && li.node.attrs.checked !== undefined
      if (task) {
        // toggle the task checkbox on the items in the selection
        if (!dispatch) return true
        const tr = state.tr
        const { from, to } = state.selection
        state.doc.nodesBetween(from, to, (n, pos) => {
          if (n.type === item) tr.setNodeAttribute(pos, 'checked', isTask ? null : false)
          return true
        })
        dispatch(tr.scrollIntoView())
        return true
      }
      if (l.node.type === listType && !isTask) return liftListItem(item)(state, dispatch)
      if (l.node.type !== listType) {
        if (!dispatch) return true
        const ordered = listName === 'ordered_list'
        const tr = state.tr.setNodeMarkup(l.pos, listType, ordered ? { order: 1, spread: l.node.attrs.spread } : { spread: l.node.attrs.spread })
        // the items' listType / label too: Milkdown's syncListOrderPlugin turns a bullet list whose first item still
        // says 'ordered' back into a (loose) ordered list
        l.node.forEach((child, off, i) => {
          if (child.type !== item) return
          const pos = l.pos + 1 + off
          tr.setNodeAttribute(pos, 'listType', ordered ? 'ordered' : 'bullet')
          tr.setNodeAttribute(pos, 'label', ordered ? `${i + 1}.` : '•')
        })
        dispatch(tr.scrollIntoView())
        return true
      }
      // a task item asking for a plain bullet: drop the checkbox
      if (!dispatch) return true
      const tr = state.tr
      state.doc.nodesBetween(state.selection.from, state.selection.to, (n, pos) => {
        if (n.type === item) tr.setNodeAttribute(pos, 'checked', null)
        return true
      })
      dispatch(tr)
      return true
    }
    if (!task) return wrapInList(listType)(state, dispatch)
    // wrap, then mark the new items as tasks, in one transaction
    let wrapped: Transaction | null = null
    if (!wrapInList(listType)(state, (tr) => (wrapped = tr))) return false
    if (!dispatch) return true
    const tr = wrapped as unknown as Transaction
    const from = tr.mapping.map(state.selection.from)
    const to = tr.mapping.map(state.selection.to)
    tr.doc.nodesBetween(from, to, (n, pos) => {
      if (n.type === item) tr.setNodeAttribute(pos, 'checked', false)
      return true
    })
    dispatch(tr.scrollIntoView())
    return true
  }
}

function toggleBlockquote(): Command {
  return (state, dispatch) => {
    const bq = node(state.schema, 'blockquote')
    if (!bq) return false
    if (ancestor(state.selection.$from, 'blockquote')) return lift(state, dispatch)
    return wrapIn(bq)(state, dispatch)
  }
}

function toggleCodeBlock(): Command {
  return (state, dispatch) => {
    const code = node(state.schema, 'code_block')
    const para = node(state.schema, 'paragraph')
    if (!code || !para) return false
    if (state.selection.$from.parent.type === code) return setBlockType(para)(state, dispatch)
    return setBlockType(code, { language: '', meta: '' })(state, dispatch)
  }
}

function heading(level: number): Command {
  return (state, dispatch) => {
    const para = node(state.schema, 'paragraph')
    const h = node(state.schema, 'heading')
    if (!para || !h) return false
    if (level === 0) return setBlockType(para)(state, dispatch)
    return setBlockType(h, { level })(state, dispatch)
  }
}

/** Insert a horizontal rule below the current top-level block (§12.13 "Headings and hr"). */
export const insertHr: Command = (state, dispatch) => {
  const hr = node(state.schema, 'hr')
  if (!hr) return false
  const $from = state.selection.$from
  const after = $from.depth > 0 ? $from.after(1) : $from.pos
  if (!dispatch) return true
  const tr = state.tr.insert(after, hr.create())
  const para = node(state.schema, 'paragraph')
  // the caret goes on a new empty paragraph below the rule, never into the block that follows it
  if (para) tr.insert(after + 1, para.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after + 2, tr.doc.content.size))))
  dispatch(tr.scrollIntoView())
  return true
}

export function commandFor(action: ToolbarAction, schema: Schema): Command | null {
  const mt = markType(schema, action)
  if (mt) return toggleFormat(mt)
  switch (action) {
    case 'heading-0':
    case 'heading-1':
    case 'heading-2':
    case 'heading-3':
      return heading(Number(action.slice(-1)))
    case 'bullet':
      return toggleList('bullet_list')
    case 'ordered':
      return toggleList('ordered_list')
    case 'task':
      return toggleList('bullet_list', true)
    case 'blockquote':
      return toggleBlockquote()
    case 'code-block':
      return toggleCodeBlock()
    case 'hr':
      return insertHr
    default:
      return null
  }
}

// ------------------------------------------------------------------ keys with structure (Tab, Enter, Backspace)

const inCode = (state: EditorState): boolean => state.selection.$from.parent.type.name === 'code_block'
const inTable = (state: EditorState): boolean => !!ancestor(state.selection.$from, 'table')

export const indent: Command = (state, dispatch) => {
  if (inCode(state)) {
    if (dispatch) dispatch(state.tr.insertText('  '))
    return true
  }
  if (inTable(state)) return goToNextCell(1)(state, dispatch)
  const item = node(state.schema, 'list_item')
  if (item && ancestor(state.selection.$from, 'list_item')) {
    sinkListItem(item)(state, dispatch)
    return true
  }
  return false
}

export const outdent: Command = (state, dispatch) => {
  if (inCode(state)) {
    const $from = state.selection.$from
    const lineStart = $from.parent.textBetween(0, $from.parentOffset).lastIndexOf('\n') + 1
    const text = $from.parent.textContent
    let n = 0
    while (n < 2 && text[lineStart + n] === ' ') n++
    if (n && dispatch) dispatch(state.tr.delete($from.start() + lineStart, $from.start() + lineStart + n))
    return true
  }
  if (inTable(state)) return goToNextCell(-1)(state, dispatch)
  const item = node(state.schema, 'list_item')
  if (item && ancestor(state.selection.$from, 'list_item')) {
    liftListItem(item)(state, dispatch)
    return true
  }
  return false
}

export const exitCodeBlock: Command = (state, dispatch) => (inCode(state) ? exitCode(state, dispatch) : false)

/**
 * Enter with structure (§12.13):
 * - a paragraph holding only ``` or ```lang, caret at its end → a code block with that language;
 * - a paragraph holding only --- / *** / ___ → a horizontal rule and a new paragraph below it;
 * - in a code block, the third Enter at the very end (the text already ends in two newlines) exits to a paragraph;
 * - in a list item: split it (a task item's new item is unchecked); an empty item leaves the list (or outdents).
 * Tables are handled by the editor (tables.ts tableEnter) before this runs. In Suggesting mode the code-fence and
 * rule conversions are D14 blocks: the editor's dispatch refuses them with SUGGEST_MODE_BLOCKED.
 * Spaces right after the caret are dropped by the split (QA2 27): the new block would start with them, and a paragraph
 * can't start with a space in markdown, so it saved as `&#x20;`.
 */
export const enterKey: Command = (state, dispatch) => {
  const gap = spacesAfterCaret(state)
  if (gap === 0) return enterAt(state, dispatch)
  const from = state.selection.from
  const trim = state.tr.delete(from, from + gap)
  // the split is computed on the trimmed doc (plugin-free state: only doc and selection matter to these commands)
  const next = EditorState.create({ doc: trim.doc, selection: trim.selection })
  const run: Command = (st, d) => enterAt(st, d) || baseKeymap.Enter!(st, d)
  if (!dispatch) return run(next)
  let split: Transaction | null = null
  if (!run(next, (t) => (split = t))) return false
  const done = split as unknown as Transaction
  // one transaction (one undo): the trim, then the split's steps
  const tr = state.tr
  for (const step of trim.steps) tr.step(step)
  for (const step of done.steps) tr.step(step)
  tr.setSelection(Selection.fromJSON(tr.doc, done.selection.toJSON()))
  if (done.storedMarks) tr.setStoredMarks(done.storedMarks)
  dispatch(tr.scrollIntoView())
  return true
}

/** How many spaces or tabs sit right after an empty selection in a splittable textblock (none in code or tracked text). */
function spacesAfterCaret(state: EditorState): number {
  const { $from, empty } = state.selection
  const parent = $from.parent
  if (!empty || !parent.isTextblock || parent.type.spec.code) return 0
  let spaces = 0
  let open = true
  parent.nodesBetween($from.parentOffset, parent.content.size, (node, pos) => {
    if (!open) return false
    if (!node.isText || node.marks.some((m) => SUGGESTION_MARKS.has(m.type.name))) {
      open = false
      return false
    }
    const text = (node.text ?? '').slice(Math.max(0, $from.parentOffset - pos))
    const lead = /^[ \t]*/.exec(text)![0].length
    spaces += lead
    if (lead < text.length) open = false
    return false
  })
  return spaces
}

const isEmptyParagraph = (n: PMNode | null | undefined): boolean => !!n && n.type.name === 'paragraph' && n.content.size === 0

const enterAt: Command = (state, dispatch) => {
  const schema = state.schema
  const { $from, empty } = state.selection
  if (inTable(state)) return true // a cell holds one line (§12.13 Tables)
  const parent = $from.parent
  if (empty && parent.type.name === 'paragraph' && $from.depth === 1) {
    // QA2 32: markdown keeps one blank line between blocks, so a second empty paragraph beside another is never saved
    // and vanishes on reload. Enter that would stack one does nothing, so the screen shows what the file keeps.
    const at = $from.index(0)
    const beside = (k: number): boolean => k >= 0 && k < state.doc.childCount && isEmptyParagraph(state.doc.child(k))
    if (parent.content.size === 0 || ($from.parentOffset === 0 && beside(at - 1)) || ($from.parentOffset === parent.content.size && beside(at + 1))) return true
  }
  if (empty && parent.type.name === 'paragraph' && $from.parentOffset === parent.content.size) {
    // the paragraph's own text, ignoring suggestion marks (Suggesting mode types the fence as a tracked insertion,
    // and the D14 filter then refuses the conversion with its notice)
    let plain = true
    let text = ''
    parent.forEach((n) => {
      const own = n.marks.filter((mk) => !SUGGESTION_MARKS.has(mk.type.name))
      if (!n.isText || own.length) plain = false
      else if (!n.marks.some((mk) => mk.type.name === 'deletion')) text += n.text ?? ''
    })
    // suggest-changes marks a tracked block boundary with a zero-width space
    text = text.split(ZWSP).join('')
    const fence = plain ? /^```([A-Za-z0-9_+#.-]*)$/.exec(text) : null
    const code = node(schema, 'code_block')
    const pos = $from.before()
    const $pos = state.doc.resolve(pos)
    if (fence && code && $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, code)) {
      if (!dispatch) return true
      const tr = state.tr.replaceWith(pos, pos + parent.nodeSize, code.create({ language: fence[1] ?? '', meta: '' }))
      tr.setSelection(TextSelection.create(tr.doc, pos + 1))
      dispatch(tr.scrollIntoView())
      return true
    }
    const hr = node(schema, 'hr')
    const para = node(schema, 'paragraph')
    if (plain && /^(?:---|\*\*\*|___)$/.test(text) && hr && para && $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, hr)) {
      if (!dispatch) return true
      const tr = state.tr.replaceWith(pos, pos + parent.nodeSize, [hr.create(), para.create()])
      tr.setSelection(TextSelection.create(tr.doc, pos + 2))
      dispatch(tr.scrollIntoView())
      return true
    }
  }
  if (parent.type.name === 'code_block' && empty && $from.parentOffset === parent.content.size && parent.textContent.endsWith('\n\n')) {
    const para = node(schema, 'paragraph')
    if (!para) return false
    if (!dispatch) return true
    const after = $from.after()
    const tr = state.tr.delete($from.pos - 2, $from.pos)
    const at = tr.mapping.map(after)
    tr.insert(at, para.create())
    tr.setSelection(TextSelection.create(tr.doc, at + 1))
    dispatch(tr.scrollIntoView())
    return true
  }
  const item = node(schema, 'list_item')
  const li = ancestor($from, 'list_item')
  if (item && li && parent.type.name !== 'code_block') {
    let split: Transaction | null = null
    if (splitListItem(item)(state, (tr) => (split = tr))) {
      if (!dispatch) return true
      const tr = split as unknown as Transaction
      const isTask = li.node.attrs.checked !== null && li.node.attrs.checked !== undefined
      if (isTask) {
        // the new item is a task item too, unchecked (split copies the old item's attrs)
        const $n = tr.selection.$from
        for (let d = $n.depth; d > 0; d--) {
          const n = $n.node(d)
          if (n.type !== item) continue
          if (n.attrs.checked !== false) tr.setNodeAttribute($n.before(d), 'checked', false)
          break
        }
      }
      dispatch(tr.scrollIntoView())
      return true
    }
    // an empty item that can't split: leave the list (or outdent a nested one)
    if (parent.content.size === 0) return liftListItem(item)(state, dispatch)
  }
  return false
}

export const hardBreak: Command = (state, dispatch) => {
  if (inTable(state)) return true
  if (inCode(state)) {
    if (dispatch) dispatch(state.tr.insertText('\n'))
    return true
  }
  const br = node(state.schema, 'hardbreak')
  if (!br) return false
  if (dispatch) dispatch(state.tr.replaceSelectionWith(br.create()).scrollIntoView())
  return true
}

/** Backspace at the very start of a list item's first block lifts the item (§12.13 Lists). */
export const backspaceLift: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const li = ancestor($from, 'list_item')
  const item = node(state.schema, 'list_item')
  if (!li || !item) return false
  // only when the caret's block is the item's first child
  if ($from.index(li.depth) !== 0) return false
  return liftListItem(item)(state, dispatch)
}

/**
 * Delete at the very end of a list item's text joins the next text onto it, as Google Docs does: "- A / - B" becomes
 * "- AB". ProseMirror's own join made one item with two paragraphs (a loose item) out of the two, and turned a paragraph
 * after the list into an item. Here the next textblock's words move to the end of this one, and the item (or nested list)
 * that held it goes if nothing else is in it; an item that still holds a nested list under that textblock hands the list
 * to this item. Returns false for anything else (a table or quote in between, a code block, an item that can't hand its
 * children over) so the default handles it.
 */
export const joinNextText: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code || $from.parentOffset !== $from.parent.content.size) return false
  const li1 = ancestor($from, 'list_item')
  if (!li1) return false
  const doc = state.doc
  const afterA = $from.after()
  const next = Selection.findFrom(doc.resolve(afterA), 1, true)
  if (!(next instanceof TextSelection)) return false
  const t2 = next.$from.parent
  const t2start = next.$from.before()
  if (!t2.isTextblock || t2.type.spec.code) return false
  // nothing but container boundaries may lie between the two textblocks (not a rule, a table, a block of any kind)
  let between = false
  doc.nodesBetween(afterA, t2start, (n, pos) => {
    if (pos >= afterA && pos + n.nodeSize <= t2start) between = true
    return !between
  })
  if (between) return false
  const $t = doc.resolve(t2start + 1)
  const shared = $from.sharedDepth(t2start + 1)
  for (let d = shared + 1; d < $t.depth; d++) {
    if (!['list_item', 'bullet_list', 'ordered_list'].includes($t.node(d).type.name)) return false
  }
  // what goes: the textblock, widened over every container that would be left empty (never one that holds the caret)
  let d = $t.depth
  let from = t2start
  let to = t2start + t2.nodeSize
  while (d - 1 > shared && $t.node(d - 1).childCount === 1) {
    from = $t.before(d - 1)
    to = $t.after(d - 1)
    d--
  }
  let rest: Fragment | null = null
  let restAt = 0
  if (d - 1 > shared && d === $t.depth) {
    // the next item has more under its first textblock: this item takes it, if the item is the very next one
    const item2 = $t.node(d - 1)
    const sameList = $from.before(li1.depth - 1) === $t.before(d - 2) && $t.index(d - 2) === $from.index(li1.depth - 1) + 1
    if (item2.type.name !== 'list_item' || !sameList || $from.index(li1.depth) !== li1.node.childCount - 1) return false
    rest = item2.content.cut(t2.nodeSize)
    restAt = $from.end(li1.depth)
    from = $t.before(d - 1)
    to = $t.after(d - 1)
  }
  if (dispatch) {
    const tr = state.tr.delete(from, to)
    if (rest) tr.insert(restAt, rest)
    tr.insert($from.pos, t2.content)
    tr.setSelection(TextSelection.create(tr.doc, $from.pos))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** Backspace at the very start of a blockquote's first block lifts that block out (§12.13 Blockquote). */
export const backspaceBlockquote: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const bq = ancestor($from, 'blockquote')
  if (!bq) return false
  // the caret's textblock must be the blockquote's first descendant block
  for (let d = bq.depth; d < $from.depth; d++) if ($from.index(d) !== 0) return false
  return lift(state, dispatch)
}

/**
 * Backspace in an empty paragraph that sits between two lists of one kind (what emptying a middle item and taking its
 * bullet off leaves): the paragraph goes and the lists become one, so the numbering carries on (Pass 4 #8). Left alone
 * the lists stay apart, a numbered one restarts at 1, and the file switched its delimiter to keep them two lists.
 */
export const backspaceBetweenLists: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.depth < 1 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size !== 0) return false
  const container = $from.node($from.depth - 1)
  const i = $from.index($from.depth - 1)
  const before = i > 0 ? container.child(i - 1) : null
  const after = i + 1 < container.childCount ? container.child(i + 1) : null
  if (!before || !after || before.type !== after.type || (before.type.name !== 'bullet_list' && before.type.name !== 'ordered_list')) return false
  if (dispatch) {
    const pos = $from.before()
    const tr = state.tr.delete(pos, pos + $from.parent.nodeSize).join(pos)
    tr.setSelection(Selection.near(tr.doc.resolve(pos - 1), -1))
    dispatch(tr.scrollIntoView())
  }
  return true
}
