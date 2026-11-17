// web/src/editor/frontmatter/view.ts (P2). The frontmatter panel: a node view over the `frontmatter` atom
// (CONTRACTS §12.12 A, R1.8, D30, §12.15).
//
// Collapsed (default): one line (data-testid="mdr-frontmatter-panel", data-expanded) with the status chip
// (mdr-frontmatter-status: the top-level /^status$/i key's value, plain text) and "N fields", or "Properties (N)"
// without a status key. Expanded (click the line, or Enter while it has focus): a key/value table. Collapse state is
// remembered per file in localStorage.
// - plain / single / double / empty fields are editable in place (the row's only input); Enter or blur commits one
//   attr change on the atom (exactly one YAML line changes, quote style kept: frontmatter/edit.ts);
// - multiline fields (and every field of an unrecognized scan, and TOML) show their source read-only with Edit YAML;
// - Add (mdr-frontmatter-add) appends `key: value` before the closing fence; Remove (mdr-frontmatter-remove) deletes
//   that one line; a duplicate key's row carries a warning and only its first occurrence is editable;
// - Edit YAML (mdr-edit-yaml) opens the whole frontmatter as text (mdr-yaml-popover, popoverField `yaml`); Save
//   replaces attrs.value with the edited text verbatim (in the frontmatter's own EOL), so untouched lines stay
//   byte-identical.
// Suggesting mode: field and raw edits are blocked (D14): focusing a field raises SUGGEST_MODE_BLOCKED.
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { NodeSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import { TESTID } from '../../../../shared/constants'
import type { Mode } from '../../../../shared/types'
import type { SuggestBlockReason } from '../../../../core/suggest/guards'
import { ARM, atomGuardKey } from '../atomGuard'
import { Popover, type PopoverSlot } from '../popover'
import { addFrontmatterField, editFrontmatterField, FrontmatterEditError, removeFrontmatterField } from './edit'
import { eolOf, frontmatterStatus, scanFrontmatter, type FrontmatterField, type FrontmatterScan } from './scan'

export interface FrontmatterHooks {
  host: HTMLElement
  slot: PopoverSlot
  mode(): Mode
  editable(): boolean
  blocked(why: SuggestBlockReason): void
  /** localStorage key for this file's collapse state. */
  storageKey(): string
  /** The document's EOL (used when the frontmatter itself has no line break yet). */
  eol(): '\n' | '\r\n'
}

function readExpanded(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeExpanded(key: string, on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(key, '1')
    else globalThis.localStorage?.removeItem(key)
  } catch {
    // storage blocked: collapse state is a convenience
  }
}

export class FrontmatterView implements NodeView {
  dom: HTMLElement
  private readonly line: HTMLElement
  private readonly body: HTMLElement
  private expanded: boolean
  private scan: FrontmatterScan

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly h: FrontmatterHooks) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement('div')
    this.dom.className = 'mdr-frontmatter'
    this.dom.dataset.testid = TESTID.frontmatterPanel
    this.dom.setAttribute('contenteditable', 'false')
    this.line = doc.createElement('div')
    this.line.className = 'mdr-frontmatter__line'
    this.line.tabIndex = 0
    this.line.setAttribute('role', 'button')
    this.line.addEventListener('click', () => this.toggle())
    this.line.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.toggle()
      }
    })
    this.body = doc.createElement('div')
    this.body.className = 'mdr-frontmatter__body'
    this.dom.append(this.line, this.body)
    this.expanded = readExpanded(h.storageKey())
    this.scan = scanFrontmatter(this.value)
    this.render()
  }

  private get value(): string {
    return String(this.node.attrs.value ?? '')
  }

  private get kind(): string {
    return String(this.node.attrs.kind ?? 'yaml')
  }

  private get readable(): boolean {
    return this.kind === 'yaml' && this.scan.recognized
  }

  private toggle(): void {
    this.expanded = !this.expanded
    writeExpanded(this.h.storageKey(), this.expanded)
    const pos = this.getPos()
    if (pos !== undefined) {
      try {
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)).setMeta(atomGuardKey, ARM))
      } catch {
        // not selectable
      }
    }
    this.render()
  }

  // ---------------------------------------------------------------- rendering

  private render(): void {
    const doc = this.dom.ownerDocument
    const focused = this.dom.contains(doc.activeElement) ? (doc.activeElement as HTMLElement | null) : null
    const focusKey = focused?.closest<HTMLElement>('[data-key]')?.dataset.key ?? null
    const focusField = focused?.dataset.field ?? null
    this.dom.dataset.expanded = String(this.expanded)
    this.line.setAttribute('aria-expanded', String(this.expanded))
    this.line.replaceChildren()
    const status = this.readable ? frontmatterStatus(this.scan) : null
    const n = this.scan.fields.length
    // what the line shows, word for word: the accessible name below is built from the same strings (WCAG 2.5.3, label in name)
    let shown: string
    if (status !== null) {
      const chip = doc.createElement('span')
      chip.className = 'mdr-frontmatter__status'
      chip.dataset.testid = TESTID.frontmatterStatus
      chip.textContent = status || '(empty)'
      const count = doc.createElement('span')
      count.className = 'mdr-frontmatter__count'
      count.textContent = `${n} field${n === 1 ? '' : 's'}`
      this.line.append(chip, doc.createTextNode(' '), count)
      shown = `${chip.textContent} ${count.textContent}`
    } else {
      const label = doc.createElement('span')
      label.className = 'mdr-frontmatter__label'
      label.textContent = this.readable ? `Properties (${n})` : this.kind === 'toml' ? 'Properties (TOML)' : 'Properties'
      this.line.append(label)
      shown = label.textContent
    }
    const caret = doc.createElement('span')
    caret.className = 'mdr-frontmatter__caret'
    caret.setAttribute('aria-hidden', 'true')
    caret.textContent = this.expanded ? '▾' : '▸'
    this.line.append(caret)
    // aria-expanded says collapsed / expanded; the name says what the line is and carries what it shows
    this.line.setAttribute('aria-label', `Document properties: ${shown}`)

    this.body.replaceChildren()
    this.body.hidden = !this.expanded
    if (!this.expanded) return
    if (!this.readable) {
      const note = doc.createElement('p')
      note.className = 'mdr-frontmatter__note'
      note.textContent = this.kind === 'toml'
        ? 'TOML properties can only be edited as text.'
        : "These properties couldn't be read as simple fields. Edit the YAML directly."
      this.body.append(note, this.editYamlButton())
      return
    }
    const table = doc.createElement('table')
    table.className = 'mdr-frontmatter__table'
    const tbody = doc.createElement('tbody')
    table.appendChild(tbody)
    for (const f of this.scan.fields) tbody.appendChild(this.row(f))
    this.body.appendChild(table)
    this.body.appendChild(this.addForm())
    const foot = doc.createElement('div')
    foot.className = 'mdr-frontmatter__foot'
    foot.appendChild(this.editYamlButton())
    this.body.appendChild(foot)
    if (focusKey !== null || focusField !== null) {
      const sel = focusField === 'new-key' || focusField === 'new-value'
        ? `[data-field="${focusField}"]`
        : `[data-testid="${TESTID.frontmatterField}"][data-key="${CSS.escape(focusKey ?? '')}"] input`
      this.body.querySelector<HTMLElement>(sel)?.focus()
    }
  }

  private row(f: FrontmatterField): HTMLTableRowElement {
    const doc = this.dom.ownerDocument
    const tr = doc.createElement('tr')
    tr.dataset.testid = TESTID.frontmatterField
    tr.dataset.key = f.key
    tr.dataset.kind = f.kind
    tr.dataset.editable = String(f.editable)
    const th = doc.createElement('th')
    th.scope = 'row'
    th.textContent = f.key
    if (f.duplicate) {
      const warn = doc.createElement('span')
      warn.className = 'mdr-frontmatter__warn'
      warn.textContent = '⚠'
      warn.title = f.editable ? 'This key appears more than once; the later copies are read-only.' : 'Duplicate key: only the first occurrence is editable.'
      warn.setAttribute('aria-label', warn.title)
      th.appendChild(warn)
    }
    const td = doc.createElement('td')
    const actions = doc.createElement('td')
    actions.className = 'mdr-frontmatter__actions'
    const err = doc.createElement('div')
    err.className = 'mdr-frontmatter__error'
    err.setAttribute('role', 'alert')
    if (f.editable) {
      const input = doc.createElement('input')
      input.type = 'text'
      input.className = 'mdr-frontmatter__input'
      input.value = f.value
      input.setAttribute('aria-label', `${f.key} value`)
      input.readOnly = !this.h.editable()
      this.guardFocus(input)
      const commit = (): void => {
        if (input.value === f.value) return
        this.apply((y) => editFrontmatterField(y, f.key, input.value), err)
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          input.value = f.value
          input.blur()
        }
      })
      input.addEventListener('blur', commit)
      td.appendChild(input)
      if (f.comment) {
        const c = doc.createElement('span')
        c.className = 'mdr-frontmatter__comment'
        c.textContent = f.comment.trim()
        td.appendChild(c)
      }
      const rm = doc.createElement('button')
      rm.type = 'button'
      rm.className = 'mdr-frontmatter__btn'
      rm.dataset.testid = TESTID.frontmatterRemove
      rm.dataset.key = f.key
      rm.textContent = 'Remove'
      rm.setAttribute('aria-label', `Remove ${f.key}`)
      rm.addEventListener('click', () => this.apply((y) => removeFrontmatterField(y, f.key), err))
      actions.appendChild(rm)
    } else {
      const pre = doc.createElement('pre')
      pre.className = 'mdr-frontmatter__source'
      pre.textContent = this.scan.lines.slice(f.line, f.endLine).join('\n')
      td.appendChild(pre)
      if (f.kind === 'multiline' || f.duplicate) actions.appendChild(this.editYamlButton('Edit YAML'))
    }
    td.appendChild(err)
    tr.append(th, td, actions)
    return tr
  }

  private addForm(): HTMLElement {
    const doc = this.dom.ownerDocument
    const form = doc.createElement('div')
    form.className = 'mdr-frontmatter__add'
    const key = doc.createElement('input')
    key.type = 'text'
    key.className = 'mdr-frontmatter__input'
    key.dataset.field = 'new-key'
    key.placeholder = 'New property'
    key.setAttribute('aria-label', 'New property name')
    const val = doc.createElement('input')
    val.type = 'text'
    val.className = 'mdr-frontmatter__input'
    val.dataset.field = 'new-value'
    val.placeholder = 'Value'
    val.setAttribute('aria-label', 'New property value')
    const err = doc.createElement('div')
    err.className = 'mdr-frontmatter__error'
    err.setAttribute('role', 'alert')
    for (const i of [key, val]) {
      i.readOnly = !this.h.editable()
      this.guardFocus(i)
    }
    const add = doc.createElement('button')
    add.type = 'button'
    add.className = 'mdr-frontmatter__btn'
    add.dataset.testid = TESTID.frontmatterAdd
    add.textContent = 'Add'
    add.setAttribute('aria-label', 'Add property')
    const commit = (): void => {
      if (this.h.mode() === 'suggesting') {
        this.h.blocked('frontmatter')
        return
      }
      const k = key.value.trim()
      if (!k) {
        err.textContent = 'Name the property first.'
        key.focus()
        return
      }
      this.apply((y) => addFrontmatterField(y, k, val.value, { eol: this.h.eol() }), err)
    }
    add.addEventListener('click', commit)
    val.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit()
      }
    })
    key.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        val.focus()
      }
    })
    form.append(key, val, add, err)
    return form
  }

  private editYamlButton(label = 'Edit YAML'): HTMLButtonElement {
    const b = this.dom.ownerDocument.createElement('button')
    b.type = 'button'
    b.className = 'mdr-frontmatter__btn'
    b.dataset.testid = TESTID.editYaml
    b.textContent = label
    b.addEventListener('click', () => this.openRaw(b))
    return b
  }

  /** Suggesting mode: a field can't take focus (D14); the notice offers Switch to Editing. */
  private guardFocus(input: HTMLInputElement): void {
    input.addEventListener('focus', () => {
      if (this.h.mode() !== 'suggesting') return
      input.blur()
      this.h.blocked('frontmatter')
    })
  }

  // ---------------------------------------------------------------- commits

  /** One attr change on the atom (a user transaction: D14 refuses it in Suggesting mode). */
  private commitValue(next: string): boolean {
    const pos = this.getPos()
    if (pos === undefined || next === this.value) return false
    const before = this.view.state.doc
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'value', next))
    return this.view.state.doc !== before
  }

  private apply(edit: (yaml: string) => string, err: HTMLElement): void {
    if (!this.h.editable()) return
    if (this.h.mode() === 'suggesting') {
      this.h.blocked('frontmatter')
      return
    }
    try {
      this.commitValue(edit(this.value))
      err.textContent = ''
    } catch (e) {
      err.textContent = e instanceof FrontmatterEditError ? e.message : 'That change could not be applied.'
    }
  }

  private openRaw(anchor: HTMLElement): void {
    const p = new Popover({
      host: this.h.host,
      className: 'mdr-popover--yaml',
      testid: TESTID.yamlPopover,
      label: this.kind === 'toml' ? 'Edit TOML' : 'Edit YAML',
      onClose: (refocus) => {
        if (refocus) this.line.focus()
      },
    })
    this.h.slot.set(p)
    const original = this.value
    const eol = eolOf(original, this.h.eol())
    const lines = original.split('\n').length
    const field = p.field('yaml', { label: this.kind === 'toml' ? 'TOML' : 'YAML', value: original.replace(/\r\n/g, '\n'), multiline: true, rows: Math.min(20, Math.max(4, lines + 1)) })
    if (!this.readable) p.note(this.kind === 'toml' ? 'TOML is edited as text.' : "These properties couldn't be read as fields; edit them as text.")
    const fence = this.kind === 'toml' ? '+++' : '---'
    const disabledReason = !this.h.editable() ? 'This document is read-only.' : this.h.mode() === 'suggesting' ? "The YAML header can't be edited in Suggesting mode." : null
    const save = (): void => {
      if (!this.h.editable()) return
      if (this.h.mode() === 'suggesting') {
        this.h.blocked('frontmatter')
        return
      }
      if (this.value !== original) {
        p.setError('The header changed since you opened it. Close and open it again.')
        return
      }
      const text = (field as HTMLTextAreaElement).value
      if (text.split('\n').some((l) => l.replace(/[ \t]+$/, '') === fence)) {
        p.setError(`A line of ${fence} would end the header early.`)
        return
      }
      // the textarea speaks \n: write the frontmatter's own EOL back, so untouched lines stay byte-identical
      const next = eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text
      this.commitValue(next)
      p.close(true)
    }
    field.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent
      if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) {
        e.preventDefault()
        save()
      }
    })
    p.action('save', 'Save', save, { primary: true, disabledReason })
    p.action('cancel', 'Cancel', () => p.close(true))
    const r = anchor.getBoundingClientRect()
    p.open({ left: r.left, bottom: r.bottom }, field)
  }

  // ---------------------------------------------------------------- NodeView

  update(n: PMNode): boolean {
    if (n.type !== this.node.type) return false
    const changed = n.attrs.value !== this.node.attrs.value || n.attrs.kind !== this.node.attrs.kind
    this.node = n
    if (changed) {
      this.scan = scanFrontmatter(this.value)
      this.render()
    }
    return true
  }

  selectNode(): void {
    this.dom.classList.add('is-selected')
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected')
  }

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }
}
