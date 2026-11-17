// web/src/editor/toolbar.ts (P2). The formatting toolbar and the mode pill, rendered into #mdr-toolbar-host
// (CONTRACTS §12.13 "Toolbar", §12.2.4, §12.15). Root data-testid="mdr-toolbar"; every button is
// data-testid="mdr-toolbar-button" with its data-action (TEST_ACTIONS.toolbarButton) and aria-pressed; the heading
// menu's items are heading-0 … heading-3; the pill is data-testid="mdr-mode-pill" with data-mode.
//
// QA3: the toolbar is one tab stop (roving tabindex; arrows, Home and End move inside it), the list and block buttons
// are drawn icons (a glyph like "1." put a visible text into a button named "Numbered list", WCAG 2.5.3), and the
// Text style button names the style the caret is in instead of sitting shaded as a toggle.
import type { EditorState } from '@milkdown/kit/prose/state'
import type { Mode } from '../../../shared/types'
import { TESTID } from '../../../shared/constants'
import { shortcut } from '../platform'
import { actionActive, actionBlockedReason, type ToolbarAction } from './commands'

/** A drawn icon: SVG path data, or a dot at (cx, cy). 16 x 16, 1.5 strokes, like the top bar's Comment and History icons. */
type Shape = string | readonly [number, number]
interface ButtonSpec { action: ToolbarAction; label: string; text: string; cls?: string; icon?: readonly Shape[]; plain?: boolean }

const ICONS = {
  undo: ['M5.5 3.5L2.8 6.2l2.7 2.7', 'M3 6.2h6a3.3 3.3 0 0 1 0 6.6H6.5'],
  redo: ['M10.5 3.5l2.7 2.7-2.7 2.7', 'M13 6.2H7a3.3 3.3 0 0 0 0 6.6h2.5'],
  bullet: [[3, 4], [3, 8], [3, 12], 'M6.5 4h7M6.5 8h7M6.5 12h7'],
  // a 1 and a 2 drawn beside three lines (the numerals are the usual list-ordered geometry, scaled to 16 px)
  ordered: ['M6.7 4h7.3M6.7 8h7.3M6.7 12h7.3', 'M2.7 4h.7v2.7M2.7 6.7h1.4', 'M4.1 12H2.7c0-.8 1.4-1.4 1.4-2.2 0-.6-.5-.9-1.4-.6'],
  task: ['M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M5.5 8.2l1.8 1.8 3.4-3.8'],
  blockquote: ['M3 3v10', 'M6.5 5h6.5M6.5 8h6.5M6.5 11h4'],
  'code-block': ['M6 3.5C4.8 3.5 4.5 4.2 4.5 5v1.2c0 .8-.5 1.5-1.5 1.8 1 .3 1.5 1 1.5 1.8V11c0 .8.3 1.5 1.5 1.5', 'M10 3.5c1.2 0 1.5.7 1.5 1.5v1.2c0 .8.5 1.5 1.5 1.8-1 .3-1.5 1-1.5 1.8V11c0 .8-.3 1.5-1.5 1.5'],
  hr: ['M2.5 8h11', 'M4.5 4.5h7M4.5 11.5h7'],
} as const satisfies Partial<Record<ToolbarAction, readonly Shape[]>>

function iconSvg(doc: Document, shapes: readonly Shape[]): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = doc.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const sh of shapes) {
    if (typeof sh === 'string') {
      const path = doc.createElementNS(ns, 'path')
      path.setAttribute('d', sh)
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
    } else {
      const dot = doc.createElementNS(ns, 'circle')
      dot.setAttribute('cx', String(sh[0]))
      dot.setAttribute('cy', String(sh[1]))
      dot.setAttribute('r', '1.1')
      dot.setAttribute('fill', 'currentColor')
      svg.appendChild(dot)
    }
  }
  return svg
}

// Undo and Redo come first, for people who don't know Cmd+Z (QA3 rail-ui 16). They are actions, not toggles: no aria-pressed.
const HISTORY: ButtonSpec[] = [
  { action: 'undo', label: `Undo (${shortcut('Mod', 'Z')})`, text: '', plain: true, icon: ICONS.undo },
  { action: 'redo', label: `Redo (${shortcut('Mod', 'Shift', 'Z')})`, text: '', plain: true, icon: ICONS.redo },
]
const BUTTONS: ButtonSpec[] = [
  { action: 'bold', label: `Bold (${shortcut('Mod', 'B')})`, text: 'B', cls: 'is-bold' },
  { action: 'italic', label: `Italic (${shortcut('Mod', 'I')})`, text: 'I', cls: 'is-italic' },
  { action: 'strike', label: `Strikethrough (${shortcut('Mod', 'Shift', 'X')})`, text: 'S', cls: 'is-strike' },
  { action: 'code', label: `Inline code (${shortcut('Mod', 'E')})`, text: '</>', cls: 'is-mono' },
  { action: 'link', label: `Link (${shortcut('Mod', 'K')})`, text: 'Link' },
]
const HEADINGS: ButtonSpec[] = [
  { action: 'heading-0', label: `Normal text (${shortcut('Mod', 'Alt', '0')})`, text: 'Normal text' },
  { action: 'heading-1', label: `Heading 1 (${shortcut('Mod', 'Alt', '1')})`, text: 'Heading 1' },
  { action: 'heading-2', label: `Heading 2 (${shortcut('Mod', 'Alt', '2')})`, text: 'Heading 2' },
  { action: 'heading-3', label: `Heading 3 (${shortcut('Mod', 'Alt', '3')})`, text: 'Heading 3' },
]
const BLOCKS: ButtonSpec[] = [
  { action: 'bullet', label: `Bulleted list (${shortcut('Mod', 'Shift', '8')})`, text: '', icon: ICONS.bullet },
  { action: 'ordered', label: `Numbered list (${shortcut('Mod', 'Shift', '7')})`, text: '', icon: ICONS.ordered },
  { action: 'task', label: `Task list (${shortcut('Mod', 'Shift', '9')})`, text: '', icon: ICONS.task },
  { action: 'blockquote', label: `Quote (${shortcut('Mod', 'Shift', 'B')})`, text: '', icon: ICONS.blockquote },
  { action: 'code-block', label: `Code block (${shortcut('Mod', 'Alt', 'C')})`, text: '', icon: ICONS['code-block'] },
  { action: 'hr', label: 'Horizontal rule', text: '', icon: ICONS.hr },
]

const STYLE_MARK = ' ▾'

export interface ToolbarHooks {
  run(action: ToolbarAction): void
  toggleMode(): void
}

export class Toolbar {
  readonly root: HTMLDivElement
  private readonly buttons = new Map<ToolbarAction, HTMLButtonElement>()
  private readonly menu: HTMLDivElement
  private readonly headingBtn: HTMLButtonElement
  private readonly pill: HTMLButtonElement
  private readonly onDocDown: (e: MouseEvent) => void
  /** The toolbar's own controls in reading order (not the heading menu's items): one of them is the tab stop. */
  private readonly stops: HTMLButtonElement[] = []
  private styleName = 'Normal text'

  constructor(private readonly host: HTMLElement, hooks: ToolbarHooks) {
    const doc = host.ownerDocument
    const root = doc.createElement('div')
    root.className = 'mdr-toolbar'
    root.setAttribute('role', 'toolbar')
    root.setAttribute('aria-label', 'Formatting')
    root.dataset.testid = TESTID.toolbar
    this.root = root

    const button = (spec: ButtonSpec, parent: HTMLElement, role?: string): HTMLButtonElement => {
      const b = doc.createElement('button')
      b.type = 'button'
      b.className = `mdr-toolbar__btn${spec.cls ? ` ${spec.cls}` : ''}`
      b.dataset.testid = TESTID.toolbarButton
      b.dataset.action = spec.action
      b.setAttribute('aria-label', spec.label)
      b.title = spec.label
      if (!spec.plain) b.setAttribute('aria-pressed', 'false')
      if (role) b.setAttribute('role', role)
      if (spec.icon) b.appendChild(iconSvg(doc, spec.icon))
      else b.textContent = spec.text
      // keep the editor's selection: act on click, never take focus on mousedown
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', (e) => {
        e.preventDefault()
        if (b.getAttribute('aria-disabled') === 'true') return
        hooks.run(spec.action)
      })
      parent.appendChild(b)
      this.buttons.set(spec.action, b)
      return b
    }

    for (const s of HISTORY) button(s, root)
    for (const s of BUTTONS) button(s, root)
    const wrap = doc.createElement('span')
    wrap.className = 'mdr-toolbar__menu-wrap'
    root.appendChild(wrap)
    this.headingBtn = button({ action: 'heading', label: 'Text style', text: `Normal text${STYLE_MARK}` }, wrap)
    this.headingBtn.setAttribute('aria-haspopup', 'menu')
    this.headingBtn.setAttribute('aria-expanded', 'false')
    // a menu button, not a toggle: it names the current style and is "on" only while its menu is open
    this.headingBtn.removeAttribute('aria-pressed')
    this.setStyleName('Normal text')
    this.menu = doc.createElement('div')
    this.menu.className = 'mdr-toolbar__menu'
    this.menu.setAttribute('role', 'menu')
    this.menu.hidden = true
    wrap.appendChild(this.menu)
    for (const s of HEADINGS) button(s, this.menu, 'menuitem')
    // keyboard: arrows open the menu and move through its items (wrapping), Escape closes it and returns to the button
    wrap.addEventListener('keydown', (e) => {
      const items = Array.from(this.menu.querySelectorAll<HTMLButtonElement>('button'))
      if (e.key === 'Escape' && this.menu.hidden !== true) {
        e.preventDefault()
        e.stopPropagation()
        this.setMenu(false)
        this.headingBtn.focus()
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
        e.preventDefault()
        if (this.menu.hidden === true) this.setMenu(true)
        const at = items.indexOf(doc.activeElement as HTMLButtonElement)
        const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]!.focus()
      }
    })
    for (const s of BLOCKS) button(s, root)

    const sep = doc.createElement('span')
    sep.className = 'mdr-toolbar__sep'
    root.appendChild(sep)
    const pill = doc.createElement('button')
    pill.type = 'button'
    pill.className = 'mdr-mode-pill'
    pill.dataset.testid = TESTID.modePill
    pill.addEventListener('mousedown', (e) => e.preventDefault())
    pill.addEventListener('click', (e) => {
      e.preventDefault()
      if (pill.getAttribute('aria-disabled') === 'true') return
      hooks.toggleMode()
    })
    root.appendChild(pill)
    this.pill = pill

    this.onDocDown = (e) => {
      if (this.menu.hidden !== true && !wrap.contains(e.target as Node)) this.setMenu(false)
    }
    doc.addEventListener('mousedown', this.onDocDown, true)

    // one tab stop (roving tabindex): Tab leaves the toolbar, arrows / Home / End move inside it
    this.stops = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.closest('.mdr-toolbar__menu'))
    for (const b of this.menu.querySelectorAll<HTMLButtonElement>('button')) b.tabIndex = -1
    this.setStop(this.stops[0] ?? null)
    root.addEventListener('focusin', (e) => {
      const t = e.target as HTMLButtonElement
      if (this.stops.includes(t)) this.setStop(t)
    })
    root.addEventListener('keydown', (e) => {
      const at = this.stops.indexOf(e.target as HTMLButtonElement)
      if (at < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const n = this.stops.length
      const to = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
      if (to < 0) return
      e.preventDefault()
      this.stops[to]!.focus()
    })
    host.appendChild(root)
  }

  private setStop(stop: HTMLButtonElement | null): void {
    for (const b of this.stops) b.tabIndex = b === stop ? 0 : -1
  }

  /** "Heading 1" / "Normal text" on the Text style button (its name carries the visible words, WCAG 2.5.3). */
  private setStyleName(name: string): void {
    this.styleName = name
    this.headingBtn.textContent = `${name}${STYLE_MARK}`
    this.headingBtn.setAttribute('aria-label', `Text style: ${name}`)
    this.headingBtn.title = `Text style: ${name}`
  }

  setMenu(open: boolean): void {
    this.menu.hidden = !open
    this.headingBtn.setAttribute('aria-expanded', String(open))
  }

  toggleMenu(): void {
    this.setMenu(this.menu.hidden === true)
  }

  setMode(m: Mode): void {
    this.pill.dataset.mode = m
    this.pill.textContent = m === 'suggesting' ? 'Suggesting' : 'Editing'
    const chord = shortcut('Mod', 'Alt', 'Shift', m === 'suggesting' ? 'E' : 'X')
    this.pill.setAttribute('aria-label', `${m === 'suggesting' ? 'Suggesting' : 'Editing'} mode: switch to ${m === 'suggesting' ? 'Editing' : 'Suggesting'} (${chord})`)
    this.pill.setAttribute('aria-pressed', String(m === 'suggesting'))
    // the aria-label says it for screen readers; the tooltip says it for everyone else
    this.pill.title = `${m === 'suggesting' ? 'Suggesting: your edits become tracked suggestions' : 'Editing: your edits go straight into the document'}. Click to switch (${chord})`
  }

  /** aria-pressed from the selection; disabled while the document is read-only (the mode pill too, QA3). */
  update(state: EditorState, editable: boolean): void {
    if ((this.pill.getAttribute('aria-disabled') === 'true') !== !editable) {
      if (editable) this.pill.removeAttribute('aria-disabled')
      else this.pill.setAttribute('aria-disabled', 'true')
    }
    const parent = state.selection.$from.parent
    const style = parent.type.name === 'heading' ? `Heading ${String(parent.attrs.level)}` : parent.type.name === 'code_block' ? 'Code block' : 'Normal text'
    if (style !== this.styleName) this.setStyleName(style)
    for (const [action, b] of this.buttons) {
      if (b.hasAttribute('aria-pressed')) {
        const pressed = actionActive(state, action)
        if (b.getAttribute('aria-pressed') !== String(pressed)) b.setAttribute('aria-pressed', String(pressed))
      }
      // in a table cell the block buttons are off, and the tooltip says why (Pass 4 #27)
      const reason = editable ? actionBlockedReason(state, action) : null
      const dis = !editable || reason !== null
      if ((b.getAttribute('aria-disabled') === 'true') !== dis) {
        if (dis) b.setAttribute('aria-disabled', 'true')
        else b.removeAttribute('aria-disabled')
      }
      const tip = reason ?? b.getAttribute('aria-label') ?? ''
      if (b.title !== tip) b.title = tip
    }
  }

  destroy(): void {
    this.root.ownerDocument.removeEventListener('mousedown', this.onDocDown, true)
    this.root.remove()
  }
}
