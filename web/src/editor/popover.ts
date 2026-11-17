// web/src/editor/popover.ts (P2). The shared shell of P2's popovers: link, raw block / inline HTML, and YAML
// (CONTRACTS §12.12, §12.13, §12.15). One popover is open at a time per editor.
//
// Every popover is a `.mdr-popover` dialog appended to #mdr-editor-host and positioned in the host's own box
// (absolute), under the anchor rect. Fields are data-testid="mdr-popover-field" with data-field
// (TEST_ACTIONS.popoverField); buttons are data-testid="mdr-popover-action" with data-action
// (TEST_ACTIONS.popoverAction). A disabled action carries aria-disabled="true" and a title saying why, and still
// receives the click (so Suggesting mode can raise its notice). Esc cancels; a mousedown outside closes.
import { TESTID } from '../../../shared/constants'

export type PopoverField = 'url' | 'text' | 'source' | 'yaml'
export type PopoverAction = 'apply' | 'cancel' | 'remove' | 'open' | 'edit' | 'save'

/** Where a popover opens, in viewport coordinates: under `bottom`, or above `top` when under it would run off the page. */
export interface PopoverAnchor {
  left: number
  bottom: number
  top?: number
}

/** The element that scrolls `el` (the page itself never scrolls), if any. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  const win = el.ownerDocument.defaultView
  for (let p = el.parentElement; p && win; p = p.parentElement) {
    const o = win.getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

export interface PopoverOptions {
  host: HTMLElement
  /** Extra class names (e.g. 'mdr-link-popover', 'mdr-popover--yaml'). */
  className: string
  testid: string
  label: string
  /** Called when the popover goes away for any reason (Esc, outside click, close()). */
  onClose?: (refocus: boolean) => void
}

export class Popover {
  readonly el: HTMLDivElement
  readonly actions: HTMLDivElement
  readonly error: HTMLDivElement
  private closed = false
  private readonly onDocDown: (e: MouseEvent) => void

  constructor(private readonly o: PopoverOptions) {
    const doc = o.host.ownerDocument
    const el = doc.createElement('div')
    el.className = `mdr-popover ${o.className}`
    el.dataset.testid = o.testid
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', o.label)
    this.el = el
    this.error = doc.createElement('div')
    this.error.className = 'mdr-popover__error'
    this.error.setAttribute('role', 'alert')
    this.actions = doc.createElement('div')
    this.actions.className = 'mdr-popover__actions'
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.close(true)
      }
    })
    this.onDocDown = (e) => {
      if (!this.el.contains(e.target as Node)) this.close(false)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  field(name: PopoverField, o: { label: string; value: string; multiline?: boolean; placeholder?: string; rows?: number }): HTMLInputElement | HTMLTextAreaElement {
    const doc = this.el.ownerDocument
    const f = o.multiline ? doc.createElement('textarea') : doc.createElement('input')
    if (f instanceof HTMLInputElement) f.type = 'text'
    else {
      f.rows = o.rows ?? 8
      f.spellcheck = false
      f.wrap = 'off'
    }
    f.className = `mdr-popover__field${o.multiline ? ' mdr-popover__field--source' : ''}`
    f.dataset.testid = TESTID.popoverField
    f.dataset.field = name
    f.placeholder = o.placeholder ?? ''
    f.setAttribute('aria-label', o.label)
    f.value = o.value
    this.el.appendChild(f)
    return f
  }

  note(text: string): HTMLDivElement {
    const n = this.el.ownerDocument.createElement('div')
    n.className = 'mdr-popover__note'
    n.textContent = text
    this.el.appendChild(n)
    return n
  }

  action(name: PopoverAction, label: string, run: () => void, o: { disabledReason?: string | null; primary?: boolean } = {}): HTMLButtonElement {
    const b = this.el.ownerDocument.createElement('button')
    b.type = 'button'
    b.className = `mdr-popover__btn${o.primary ? ' is-primary' : ''}`
    b.dataset.testid = TESTID.popoverAction
    b.dataset.action = name
    b.textContent = label
    if (o.disabledReason) {
      b.setAttribute('aria-disabled', 'true')
      b.title = o.disabledReason
    }
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
      e.preventDefault()
      run()
    })
    this.actions.appendChild(b)
    return b
  }

  setError(text: string): void {
    this.error.textContent = text
  }

  /** Mount under `rect` (viewport coordinates), in the host's own box. */
  open(rect: PopoverAnchor | null, focus?: HTMLElement | null): void {
    this.el.append(this.error, this.actions)
    const host = this.o.host
    if (rect) {
      const h = host.getBoundingClientRect()
      this.el.style.top = `${Math.max(0, rect.bottom - h.top + 4)}px`
      this.el.style.left = `${Math.max(0, rect.left - h.left)}px`
    } else {
      this.el.style.top = '0px'
      this.el.style.left = '0px'
    }
    host.appendChild(this.el)
    if (rect) this.fit(rect)
    this.el.ownerDocument.addEventListener('mousedown', this.onDocDown, true)
    focus?.focus()
  }

  /**
   * Keep the field and its buttons in view (Pass 4 #19: under a selection near the bottom of the window, Apply and
   * Cancel sat below the fold). It flips above the anchor when there is room there, else scrolls into view. Measured
   * after mounting, so it does nothing where there is no layout.
   */
  private fit(rect: PopoverAnchor): void {
    const box = this.el.getBoundingClientRect()
    if (!box.height) return
    const scroller = scrollParent(this.el)
    const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: this.el.ownerDocument.defaultView?.innerHeight ?? Infinity }
    if (box.bottom <= view.bottom) return
    if (rect.top !== undefined && rect.top - box.height - 4 >= view.top) {
      this.el.style.top = `${rect.top - box.height - 4 - this.o.host.getBoundingClientRect().top}px`
      return
    }
    this.el.scrollIntoView({ block: 'nearest' })
  }

  close(refocus: boolean): void {
    if (this.closed) return
    this.closed = true
    this.el.ownerDocument.removeEventListener('mousedown', this.onDocDown, true)
    this.el.remove()
    this.o.onClose?.(refocus)
  }
}

/** Keeps at most one popover open per editor. */
export class PopoverSlot {
  private cur: Popover | null = null

  get current(): Popover | null {
    return this.cur && !this.cur.isClosed ? this.cur : null
  }

  set(p: Popover): void {
    this.close(false)
    this.cur = p
  }

  close(refocus: boolean): void {
    const c = this.cur
    this.cur = null
    if (c && !c.isClosed) c.close(refocus)
  }
}
