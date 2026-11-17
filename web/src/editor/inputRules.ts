// web/src/editor/inputRules.ts (P2). Auto-format input rules (CONTRACTS §12.13 "Input rules").
//
// P2 removes the commonmark and gfm presets' input rules (their `---` fires on the third dash, `|2x2|` inserts a
// table, and `[ ] ` uses a structural step) and installs exactly the §12.13 table:
//   **text** / __text__ → bold · *text* / _text_ → italic · `text` → inline code · ~~text~~ → strikethrough
//   # … ###### at line start → heading 1-6 · - / * / + → bullet list · 1. / 1) → ordered list from that number
//   [ ] / [x] at the start of a list item → task item (so `- [ ] ` at line start works too) · > → blockquote
// The code fence (``` or ```lang) and the horizontal rule (--- / *** / ___) fire on Enter, so they live in the Enter
// command (commands.ts), not here.
// No rule fires inside code_block (prosemirror-inputrules skips `code` textblocks) or inside inline code (guarded
// with inCodeMark: false). Each rule's transaction is an ordinary user transaction: in Suggesting mode `# ` becomes a structure
// suggestion and `**x**` a format suggestion. Backspace right after a rule undoes it (undoInputRule, keymap).
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from '@milkdown/kit/prose/inputrules'
import type { Attrs, MarkType, Node as PMNode, NodeType, Schema } from '@milkdown/kit/prose/model'
import type { EditorState, Plugin, Transaction } from '@milkdown/kit/prose/state'
import { canJoin, findWrapping } from '@milkdown/kit/prose/transform'
import { suggestChangesKey } from '@handlewithcare/prosemirror-suggest-changes'
import { markIdOf, suggestionMarkTypes } from '../../../core/suggest/guards'
import { autolinkBefore } from './autolink'
import { linkAllowed, normalizeLinkInput } from './linkPopover'

/**
 * A delimiter mark rule: `re` matches at the end of the typed text with group 1 = the delimited span and group 2 =
 * its content; `delim` is the delimiter length. The final delimiter char is the one being typed (not in the doc yet).
 */
function markRule(re: RegExp, type: MarkType, delim: number): InputRule {
  return new InputRule(re, (state, match, start, end) => {
    const full = match[1]
    const inner = match[2]
    if (!full || !inner) return null
    const from = start + (match[0].length - full.length)
    const tr = state.tr
    // closing delimiter chars already in the doc (all but the typed one), then the opening delimiter
    tr.delete(end - (delim - 1), end)
    tr.delete(from, from + delim)
    tr.addMark(from, from + inner.length, type.create())
    tr.removeStoredMark(type)
    return tr
  })
}

/** `[ ] ` / `[x] ` at the very start of a list item's first paragraph: the item becomes a task item. */
function taskRule(): InputRule {
  return new InputRule(/^\u200b?\[([ xX])\]\s$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start)
    if ($start.depth < 2) return null
    const item = $start.node(-1)
    if (item.type.name !== 'list_item' || $start.index(-1) !== 0) return null
    if (item.attrs.checked !== null && item.attrs.checked !== undefined) return null
    const itemPos = $start.before(-1)
    // setNodeAttribute (an AttrStep), so the D14 check and the decision journal see a task toggle (§6.5)
    return state.tr.delete(start, end).setNodeAttribute(itemPos, 'checked', match[1]!.toLowerCase() === 'x')
  })
}

/**
 * A block rule that may match after a leading zero-width space (the tracked split's marker in a paragraph TJ just
 * opened with Enter in Suggesting mode): the rule's range starts after it, so the marker stays and keeps the new block
 * tied to the split (deleting it would leave an extra empty block when the suggestions revert).
 */
function afterZwsp(rule: InputRule): InputRule {
  const { match: re, handler } = rule as unknown as { match: RegExp; handler: (s: EditorState, m: RegExpMatchArray, from: number, to: number) => Transaction | null }
  return new InputRule(re, (state, match, start, end) => handler(state, match, start + (match[0].startsWith('\u200b') ? 1 : 0), end))
}

/** The suggestion id when the whole textblock at `pos` is a pending insertion (a paragraph TJ just opened with Enter), else null. */
function ownInsertionId(state: EditorState, pos: number): string | null {
  const parent = state.doc.resolve(pos).parent
  const { insertion } = suggestionMarkTypes(state.schema)
  let id: string | null = null
  let all = parent.childCount > 0
  parent.forEach((child) => {
    const m = insertion.isInSet(child.marks)
    if (!m) all = false
    else id ??= markIdOf(m)
  })
  return all ? id : null
}

/**
 * A wrapping rule (bullet, ordered, quote) that is also right in Suggesting mode on a paragraph that is itself TJ's
 * pending insertion. The library would track the wrap as "this paragraph deleted, a list inserted", which on a block that
 * was never in the base reverts to an extra empty paragraph. So the wrap is applied as it is, and its new wrapper nodes
 * carry the same insertion id: reverting the suggestion takes them away with the text, accepting keeps them.
 */
function wrapRule(re: RegExp, type: NodeType, getAttrs?: (m: RegExpMatchArray) => Attrs, join?: (m: RegExpMatchArray, node: PMNode) => boolean): InputRule {
  const plain = afterZwsp(wrappingInputRule(re, type, getAttrs, join))
  const base = plain as unknown as { handler: (s: EditorState, m: RegExpMatchArray, from: number, to: number) => Transaction | null }
  return new InputRule(re, (state, match, start, end) => {
    const from = start + (match[0].startsWith('\u200b') ? 1 : 0)
    const id = ownInsertionId(state, from)
    if (!id) return base.handler(state, match, start, end)
    const tr = state.tr.delete(from, end)
    const range = tr.doc.resolve(from).blockRange()
    const wrapping = range && findWrapping(range, type, getAttrs?.(match))
    if (!range || !wrapping) return null
    const at = range.start
    tr.wrap(range, wrapping)
    const { insertion } = suggestionMarkTypes(state.schema)
    for (let i = 0; i < wrapping.length; i++) tr.addNodeMark(at + i, insertion.create({ id }))
    const before = tr.doc.resolve(from - 1).nodeBefore
    if (before && before.type === type && canJoin(tr.doc, from - 1) && (!join || join(match, before))) tr.join(from - 1)
    return tr.setMeta(suggestChangesKey, { skip: true })
  })
}

/** The heading rule, with the same own-insertion case as wrapRule: the new block's type is part of TJ's insertion, not a second tracked change. */
function headingRule(type: NodeType): InputRule {
  const re = /^\u200b?(#{1,6})\s$/
  const level = (m: RegExpMatchArray): Attrs => ({ level: m[1]!.length })
  const plain = afterZwsp(textblockTypeInputRule(re, type, level)) as unknown as { handler: (s: EditorState, m: RegExpMatchArray, from: number, to: number) => Transaction | null }
  return new InputRule(re, (state, match, start, end) => {
    const from = start + (match[0].startsWith('\u200b') ? 1 : 0)
    if (!ownInsertionId(state, from)) return plain.handler(state, match, start, end)
    const $from = state.doc.resolve(from)
    if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type)) return null
    return state.tr.delete(from, end).setBlockType(from, from, type, level(match)).setMeta(suggestChangesKey, { skip: true })
  })
}

/**
 * Space after a typed URL, www. address or email links it, as in Google Docs (QA3; Editing mode only, `enabled`). The
 * typed space is inserted outside the link.
 */
function autolinkRule(enabled: () => boolean): InputRule {
  return new InputRule(/(?:https?:\/\/|www\.|@)\S*\s$/, (state, match, _start, end) => {
    if (!enabled()) return null
    const tr = autolinkBefore(state, end)
    if (!tr) return null
    const link = state.schema.marks.link!
    return tr.setStoredMarks(state.doc.resolve(end).marks().filter((m) => m.type !== link)).insertText(match[0].slice(-1), end)
  })
}

/** Typed `[text](url)` becomes a link on its closing `)`, like `**bold**` becomes bold (QA3). Not after `!` (an image). */
function linkSyntaxRule(link: MarkType): InputRule {
  return new InputRule(/\[([^[\]\n]+)\]\(([^()\s]+)\)$/, (state, match, start, end) => {
    const href = normalizeLinkInput(match[2]!)
    if (!href || !linkAllowed(href) || (start > 0 && state.doc.textBetween(Math.max(0, start - 1), start) === '!')) return null
    const marks = state.doc.resolve(start).marks().filter((m) => m.type !== link)
    return state.tr.replaceWith(start, end, state.schema.text(match[1]!, link.create({ href, title: null }).addToSet(marks))).setStoredMarks(marks)
  })
}

export interface MdrInputRuleOptions {
  /** Link an address when Space follows it (the editor passes "Editing mode"). */
  autolink?: () => boolean
}

export function mdrInputRules(schema: Schema, o: MdrInputRuleOptions = {}): InputRule[] {
  const rules: InputRule[] = []
  const { strong, emphasis, inlineCode, strike_through: strike } = schema.marks
  const { heading, bullet_list: bullet, ordered_list: ordered, blockquote } = schema.nodes
  if (inlineCode) rules.push(markRule(/(?:^|[^`\\])(`([^`]+)`)$/, inlineCode, 1))
  if (strong) {
    rules.push(markRule(/(?:^|[^*\\])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/, strong, 2))
    rules.push(markRule(/(?:^|[^_\w\\])(__([^_\s](?:[^_]*[^_\s])?)__)$/, strong, 2))
  }
  if (emphasis) {
    rules.push(markRule(/(?:^|[^*\\])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/, emphasis, 1))
    rules.push(markRule(/(?:^|[^_\w\\])(_([^_\s](?:[^_]*[^_\s])?)_)$/, emphasis, 1))
  }
  if (strike) rules.push(markRule(/(?:^|[^~\\])(~~([^~\s](?:[^~]*[^~\s])?)~~)$/, strike, 2))
  // Enter in Suggesting mode leaves a zero-width space (U+200B) at the start of the new paragraph (the library's mark for
  // the tracked split), so every block rule allows one before its trigger; the rule's range includes it and removes it
  if (heading) rules.push(headingRule(heading))
  if (bullet) rules.push(wrapRule(/^\u200b?\s*([-+*])\s$/, bullet))
  if (ordered) {
    rules.push(wrapRule(/^\u200b?\s*(\d+)[.)]\s$/, ordered, (m) => ({ order: Number(m[1]) }), (m, node) => node.childCount + Number(node.attrs.order) === Number(m[1])))
  }
  if (schema.nodes.list_item) rules.push(taskRule())
  if (blockquote) rules.push(wrapRule(/^\u200b?\s*>\s$/, blockquote))
  if (schema.marks.link) {
    rules.push(linkSyntaxRule(schema.marks.link))
    if (o.autolink) rules.push(autolinkRule(o.autolink))
  }
  // never inside inline code (prosemirror-inputrules checks the caret's marks and the matched range)
  for (const r of rules) r.inCodeMark = false
  return rules
}

export function mdrInputRulesPlugin(schema: Schema, o: MdrInputRuleOptions = {}): Plugin {
  return inputRules({ rules: mdrInputRules(schema, o) })
}
