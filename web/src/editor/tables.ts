// web/src/editor/tables.ts (P2). GFM table editing (CONTRACTS §12.13 "Tables", R1.7, D51).
//
// The doc model is Milkdown's: table > table_header_row (table_header*) , table_row+ (table_cell*), each cell one
// paragraph. A header-only GFM table loads as the header row plus one EMPTY table_row (no cells), which serializes
// back to the header alone; every command here keeps that shape, so the saved table always equals what load() gives.
//
// - Structure commands (tableAction values): row-above / row-below / row-delete / col-left / col-right /
//   col-delete / align-left / align-center / align-right / align-none / table-delete, each acting on the row or
//   column of the selection's cell, with the header-row and last-column rules (row-above disabled on the header,
//   row-delete disabled on it while body rows exist and = table-delete without them, col-delete on the only column
//   = table-delete, deleting the last body row leaves a valid header-only table).
// - The control bar (data-testid="mdr-table-controls") sits just above the table, left-aligned with it, inside the
//   editor host; every button is mdr-table-action with data-action, aria-label and, when disabled,
//   aria-disabled="true" plus a title saying why. In Suggesting mode every button is disabled and a click raises
//   SUGGEST_MODE_BLOCKED (D14: structure steps can't be tracked); cell text edits stay tracked.
// - Keys: Tab / Shift+Tab next / previous cell (wrapping rows); Tab in the last cell adds a body row in Editing
//   mode (Suggesting: stops there and raises the notice); Enter moves to the cell below, and from the last row
//   leaves the table into the paragraph below (creating an empty one); Shift+Enter does nothing (keymap).
// - fixTablesGuard: prosemirror-tables' fixTables would fill the empty header-only row with cells (turning
//   `| a |\n| - |` into a table with an empty body row) on the next edit; the guard refuses that one repair.
import type { Node as PMNode, NodeType, Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { fixTablesKey } from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'
import { TESTID, TEST_ACTIONS } from '../../../shared/constants'
import type { Mode } from '../../../shared/types'

export type TableAction = (typeof TEST_ACTIONS.tableAction)[number]
export type Alignment = 'left' | 'center' | 'right' | null

export interface CellInfo {
  table: PMNode
  tablePos: number
  /** Row index (0 = the header row) and column index of the selection's cell. */
  row: number
  col: number
  /** Number of columns (the header row's cells). */
  cols: number
  /** True when at least one body row has cells (a header-only table has none). */
  hasBody: boolean
  cellPos: number
}

const CELL_NAMES = new Set(['table_cell', 'table_header'])

/** The table cell around the selection head, or null outside tables. */
export function cellAt(state: EditorState): CellInfo | null {
  const $p = state.selection.$head
  for (let d = $p.depth; d > 2; d--) {
    const n = $p.node(d)
    if (!CELL_NAMES.has(n.type.name)) continue
    const table = $p.node(d - 2)
    if (table.type.name !== 'table') return null
    return {
      table,
      tablePos: $p.before(d - 2),
      row: $p.index(d - 2),
      col: $p.index(d - 1),
      cols: table.firstChild?.childCount ?? 0,
      hasBody: bodyRowCount(table) > 0,
      cellPos: $p.before(d),
    }
  }
  return null
}

export function bodyRowCount(table: PMNode): number {
  let n = 0
  table.forEach((row, _o, i) => {
    if (i > 0 && row.childCount > 0) n++
  })
  return n
}

/** Start position of row `r` (the position before the row node). */
function rowPos(table: PMNode, tablePos: number, r: number): number {
  let pos = tablePos + 1
  for (let i = 0; i < r; i++) pos += table.child(i).nodeSize
  return pos
}

/** Start position of cell `c` in row `r`. */
function cellPos(table: PMNode, tablePos: number, r: number, c: number): number {
  const row = table.child(r)
  let pos = rowPos(table, tablePos, r) + 1
  for (let i = 0; i < c && i < row.childCount; i++) pos += row.child(i).nodeSize
  return pos
}

function columnAlignments(table: PMNode): Alignment[] {
  const out: Alignment[] = []
  table.firstChild?.forEach((cell) => out.push((cell.attrs.alignment ?? null) as Alignment))
  return out
}

function emptyCell(schema: Schema, type: NodeType, alignment: Alignment): PMNode {
  return type.create({ alignment }, schema.nodes.paragraph!.create())
}

function newBodyRow(schema: Schema, table: PMNode): PMNode {
  const cell = schema.nodes.table_cell!
  return schema.nodes.table_row!.create(null, columnAlignments(table).map((a) => emptyCell(schema, cell, a)))
}

/** The selection inside cell (r, c) of the table at tablePos in tr.doc: its whole text, or the caret in an empty cell. */
function selectCell(tr: Transaction, tablePos: number, r: number, c: number): Transaction {
  const table = tr.doc.nodeAt(tablePos)
  if (!table || r >= table.childCount) return tr
  const row = table.child(r)
  if (row.childCount === 0) return tr
  const cc = Math.min(c, row.childCount - 1)
  const pos = cellPos(table, tablePos, r, cc)
  const cell = tr.doc.nodeAt(pos)!
  const start = pos + 2 // cell > paragraph > text
  const end = pos + cell.nodeSize - 2
  return tr.setSelection(TextSelection.create(tr.doc, start, Math.max(start, end)))
}

function caretInCell(tr: Transaction, tablePos: number, r: number, c: number): Transaction {
  const table = tr.doc.nodeAt(tablePos)
  if (!table || r >= table.childCount || table.child(r).childCount === 0) return tr
  const pos = cellPos(table, tablePos, r, Math.min(c, table.child(r).childCount - 1))
  return tr.setSelection(TextSelection.create(tr.doc, pos + 2))
}

// ------------------------------------------------------------------ action state

export interface ActionState {
  enabled: boolean
  /** Why it is disabled (the button's title). */
  reason?: string
  /** What the action really does (row-delete on a header-only table and col-delete on the only column delete it). */
  effective: TableAction
}

const LABELS: Readonly<Record<TableAction, string>> = {
  'row-above': 'Insert row above',
  'row-below': 'Insert row below',
  'row-delete': 'Delete row',
  'col-left': 'Insert column left',
  'col-right': 'Insert column right',
  'col-delete': 'Delete column',
  'align-left': 'Align column left',
  'align-center': 'Align column center',
  'align-right': 'Align column right',
  'align-none': 'Clear column alignment',
  'table-delete': 'Delete table',
}

const GLYPHS: Readonly<Record<TableAction, string>> = {
  'row-above': '↑+', 'row-below': '↓+', 'row-delete': '−row', 'col-left': '←+', 'col-right': '→+', 'col-delete': '−col',
  'align-left': '⇤', 'align-center': '↔', 'align-right': '⇥', 'align-none': '∅', 'table-delete': '⌫',
}

export const SUGGESTING_TABLE_REASON = "Table structure can't be changed in Suggesting mode."

export function actionState(info: CellInfo, action: TableAction, mode: Mode): ActionState {
  let effective: TableAction = action
  let reason: string | undefined
  if (action === 'row-above' && info.row === 0) reason = 'The header row is always the first row.'
  if (action === 'row-delete' && info.row === 0) {
    if (info.hasBody) reason = "The header row can't be deleted while the table has other rows."
    else effective = 'table-delete'
  }
  if (action === 'col-delete' && info.cols <= 1) effective = 'table-delete'
  if (action.startsWith('align-')) {
    const want = action === 'align-none' ? null : action.slice('align-'.length)
    const cur = (info.table.firstChild?.maybeChild(info.col)?.attrs.alignment ?? null) as Alignment
    if (cur === want) reason = 'The column already has this alignment.'
  }
  if (mode === 'suggesting') reason = SUGGESTING_TABLE_REASON
  return { enabled: reason === undefined, effective, ...(reason !== undefined ? { reason } : {}) }
}

// ------------------------------------------------------------------ structure commands

/** Build the transaction for a structure action at `info` (null when it can't apply). Pure over the state. */
export function tableActionTr(state: EditorState, info: CellInfo, action: TableAction): Transaction | null {
  const schema = state.schema
  const { table, tablePos, row: r, col: c } = info
  const st = actionState(info, action, 'editing')
  if (!st.enabled) return null
  const tr = state.tr
  switch (st.effective) {
    case 'row-above': {
      tr.insert(rowPos(table, tablePos, r), newBodyRow(schema, table))
      return caretInCell(tr, tablePos, r, c)
    }
    case 'row-below': {
      const body = newBodyRow(schema, table)
      if (r === 0 && !info.hasBody) {
        // header-only: the empty placeholder row becomes the first body row
        const p = rowPos(table, tablePos, 1)
        tr.replaceWith(p, p + table.child(1).nodeSize, body)
      } else tr.insert(rowPos(table, tablePos, r + 1), body)
      return caretInCell(tr, tablePos, r + 1, c)
    }
    case 'row-delete': {
      const p = rowPos(table, tablePos, r)
      const node = table.child(r)
      if (bodyRowCount(table) === 1 && node.childCount > 0) {
        // the last body row: leave a valid header-only table (header + one empty row, as load() gives it)
        tr.replaceWith(p, p + node.nodeSize, schema.nodes.table_row!.create())
        return caretInCell(tr, tablePos, 0, c)
      }
      tr.delete(p, p + node.nodeSize)
      return caretInCell(tr, tablePos, Math.min(r, tr.doc.nodeAt(tablePos)!.childCount - 1), c)
    }
    case 'col-left':
    case 'col-right': {
      const at = st.effective === 'col-left' ? c : c + 1
      // last row first, so earlier positions stay valid
      for (let i = table.childCount - 1; i >= 0; i--) {
        const row = table.child(i)
        if (row.childCount === 0) continue
        const type = i === 0 ? schema.nodes.table_header! : schema.nodes.table_cell!
        tr.insert(cellPos(table, tablePos, i, Math.min(at, row.childCount)), emptyCell(schema, type, null))
      }
      return caretInCell(tr, tablePos, r, at)
    }
    case 'col-delete': {
      for (let i = table.childCount - 1; i >= 0; i--) {
        const row = table.child(i)
        if (row.childCount <= c) continue
        const p = cellPos(table, tablePos, i, c)
        tr.delete(p, p + row.child(c).nodeSize)
      }
      return caretInCell(tr, tablePos, r, Math.max(0, c - (c >= info.cols - 1 ? 1 : 0)))
    }
    case 'align-left':
    case 'align-center':
    case 'align-right':
    case 'align-none': {
      const value: Alignment = st.effective === 'align-none' ? null : (st.effective.slice('align-'.length) as Alignment)
      for (let i = 0; i < table.childCount; i++) {
        const row = table.child(i)
        if (row.childCount <= c) continue
        tr.setNodeAttribute(cellPos(table, tablePos, i, c), 'alignment', value)
      }
      return tr
    }
    case 'table-delete': {
      tr.delete(tablePos, tablePos + table.nodeSize)
      if (tr.doc.childCount === 0) tr.insert(0, schema.nodes.paragraph!.create())
      const at = Math.min(tablePos, tr.doc.content.size)
      tr.setSelection(TextSelection.near(tr.doc.resolve(at), at > 0 ? -1 : 1))
      return tr
    }
    default:
      return null
  }
}

// ------------------------------------------------------------------ keys

/** The (row, col) cells of a table in reading order, skipping empty rows. */
function cellOrder(table: PMNode): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = []
  table.forEach((row, _o, r) => {
    for (let c = 0; c < row.childCount; c++) out.push({ r, c })
  })
  return out
}

export interface TableKeyHooks {
  mode(): Mode
  blocked(): void
}

/** Tab (dir 1) / Shift+Tab (dir -1) inside a table. Returns false outside tables. */
export function tableTab(dir: 1 | -1, h: TableKeyHooks): Command {
  return (state, dispatch) => {
    const info = cellAt(state)
    if (!info) return false
    const order = cellOrder(info.table)
    const i = order.findIndex((x) => x.r === info.row && x.c === info.col)
    const next = order[i + dir]
    if (next) {
      if (dispatch) dispatch(selectCell(state.tr, info.tablePos, next.r, next.c).scrollIntoView())
      return true
    }
    if (dir < 0) return true // the first cell: stay
    // the last cell: a new body row (Editing mode only)
    if (h.mode() === 'suggesting') {
      h.blocked()
      return true
    }
    const tr = tableActionTr(state, { ...info, row: info.row }, 'row-below')
    if (tr && dispatch) dispatch(caretInCell(tr, info.tablePos, info.row + 1, 0).scrollIntoView())
    return true
  }
}

/** Enter in a cell: the cell below; from the last row, the paragraph after the table (created if none follows). */
export const tableEnter: Command = (state, dispatch) => {
  const info = cellAt(state)
  if (!info) return false
  const { table, tablePos } = info
  for (let r = info.row + 1; r < table.childCount; r++) {
    if (table.child(r).childCount === 0) continue
    if (dispatch) dispatch(caretInCell(state.tr, tablePos, r, info.col).scrollIntoView())
    return true
  }
  const after = tablePos + table.nodeSize
  const next = state.doc.nodeAt(after)
  const tr = state.tr
  if (next && next.type.name === 'paragraph') tr.setSelection(TextSelection.create(tr.doc, after + 1))
  else {
    tr.insert(after, state.schema.nodes.paragraph!.create())
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
  }
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

// ------------------------------------------------------------------ fixTables guard

/** True when `table` is in the header-only shape (a body row with no cells). */
function hasEmptyRow(table: PMNode): boolean {
  let hit = false
  table.forEach((row, _o, i) => {
    if (i > 0 && row.childCount === 0) hit = true
  })
  return hit
}

export const fixTablesGuardKey = new PluginKey('mdr-fix-tables-guard')

export function fixTablesGuard(): Plugin {
  return new Plugin({
    key: fixTablesGuardKey,
    filterTransaction(tr) {
      if (!tr.getMeta(fixTablesKey)) return true
      let refuse = false
      tr.before.descendants((n) => {
        if (refuse) return false
        if (n.type.name === 'table') {
          if (hasEmptyRow(n)) refuse = true
          return false
        }
        return n.isBlock && !n.isTextblock
      })
      return !refuse
    },
  })
}

// ------------------------------------------------------------------ the control bar

export interface TableControlsHooks {
  host: HTMLElement
  mode(): Mode
  editable(): boolean
  /** Run a structure action (the editor dispatches it as a user transaction). */
  run(action: TableAction): void
  /** Suggesting mode: raise SUGGEST_MODE_BLOCKED. */
  blocked(): void
}

export class TableControls {
  readonly el: HTMLDivElement
  private readonly buttons = new Map<TableAction, HTMLButtonElement>()
  private info: CellInfo | null = null

  constructor(private readonly h: TableControlsHooks) {
    const doc = h.host.ownerDocument
    const el = doc.createElement('div')
    el.className = 'mdr-table-controls'
    el.dataset.testid = TESTID.tableControls
    el.setAttribute('role', 'toolbar')
    el.setAttribute('aria-label', 'Table')
    el.hidden = true
    for (const action of TEST_ACTIONS.tableAction) {
      const b = doc.createElement('button')
      b.type = 'button'
      b.className = 'mdr-table-controls__btn'
      b.dataset.testid = TESTID.tableAction
      b.dataset.action = action
      b.setAttribute('aria-label', LABELS[action])
      b.title = LABELS[action]
      b.textContent = GLYPHS[action]
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', (e) => {
        e.preventDefault()
        this.click(action)
      })
      if (action === 'align-left' || action === 'table-delete') {
        const sep = doc.createElement('span')
        sep.className = 'mdr-table-controls__sep'
        el.appendChild(sep)
      }
      el.appendChild(b)
      this.buttons.set(action, b)
    }
    this.el = el
    h.host.appendChild(el)
  }

  private click(action: TableAction): void {
    if (!this.info || !this.h.editable()) return
    if (this.h.mode() === 'suggesting') {
      this.h.blocked()
      return
    }
    if (this.buttons.get(action)?.getAttribute('aria-disabled') === 'true') return
    this.h.run(action)
  }

  update(view: EditorView): void {
    const info = this.h.editable() ? cellAt(view.state) : null
    this.info = info
    if (!info) {
      this.el.hidden = true
      return
    }
    const mode = this.h.mode()
    for (const [action, b] of this.buttons) {
      const st = actionState(info, action, mode)
      const label = st.effective !== action ? `${LABELS[action]} (deletes the table)` : LABELS[action]
      b.setAttribute('aria-label', label)
      if (st.enabled) {
        b.removeAttribute('aria-disabled')
        b.title = label
      } else {
        b.setAttribute('aria-disabled', 'true')
        b.title = st.reason ?? label
      }
      b.setAttribute('aria-pressed', String(action.startsWith('align-') && st.reason === 'The column already has this alignment.'))
    }
    this.el.hidden = false
    this.place(view, info)
  }

  private place(view: EditorView, info: CellInfo): void {
    try {
      const dom = view.nodeDOM(info.tablePos) as HTMLElement | null
      const box = (dom?.nodeName === 'TABLE' ? dom : (dom?.querySelector?.('table') ?? dom))?.getBoundingClientRect()
      const host = this.h.host.getBoundingClientRect()
      if (!box) return
      const height = this.el.offsetHeight || 28
      this.el.style.top = `${Math.max(0, box.top - host.top - height - 4)}px`
      this.el.style.left = `${Math.max(0, box.left - host.left)}px`
    } catch {
      // no layout (jsdom)
    }
  }

  destroy(): void {
    this.el.remove()
  }
}

/** The plugin view that keeps the control bar in step with the selection. */
export function tableControlsPlugin(make: (view: EditorView) => TableControls): Plugin {
  return new Plugin({
    key: new PluginKey('mdr-table-controls'),
    view(view) {
      const c = make(view)
      c.update(view)
      return {
        update: (v) => c.update(v),
        destroy: () => c.destroy(),
      }
    },
  })
}
