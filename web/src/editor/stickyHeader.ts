// web/src/editor/stickyHeader.ts. A long table's header row stays pinned to the top of the scroll box while the reader
// scrolls through that table, and lets go once the table's last row reaches it (TJ ask, 2026-11-11).
//
// Why not plain CSS: every table is `display: block; overflow-x: auto` (a wide table scrolls inside its own box), and
// that makes the table its own scroll container, so `position: sticky` on a header cell sticks to the table, which
// never scrolls vertically, and silently does nothing. Two paths instead:
// - A table that fits the column gets `overflow: visible` (it has nothing to scroll sideways), so the static sticky
//   rule in editor.css binds to the real scroll box (.mdr-scroll). That is compositor-smooth.
// - A table wider than the column keeps its sideways scroll; while it straddles the top edge its header cells get a
//   translateY that follows the vertical scroll (the transform rides along with the sideways scroll for free).
//
// Neither path writes to ProseMirror's DOM: an attribute change on a node ProseMirror owns makes its DOM observer
// re-read that range. Everything goes into one <style> element this plugin owns, keyed by the table's position among
// the editor root's children (tables nested in lists or other blocks are left alone).
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

export const stickyHeaderKey = new PluginKey('mdr-sticky-table-header')

const ROOT = '#mdr-editor-host .ProseMirror'

function scrollParent(el: HTMLElement): HTMLElement | null {
  const win = el.ownerDocument.defaultView
  for (let p = el.parentElement; p && win; p = p.parentElement) {
    const o = win.getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/** The header cells of the table at 1-based child index `n` of the editor root. */
function headCells(n: number): string {
  return `${ROOT} > table:nth-child(${n}) > tbody > tr:first-child > th, ${ROOT} > table:nth-child(${n}) > thead > tr > th`
}

class StickyHeader {
  private readonly style: HTMLStyleElement
  private fitCss = ''
  private shiftCss = ''
  private scroller: HTMLElement | null = null
  private frame: number | null = null
  /** Frames left to wait for the editor to be attached and laid out (the plugin view is made before it is). */
  private waits = 600
  private readonly ro: ResizeObserver | null
  private readonly onScroll = (): void => this.schedule()
  private readonly onResize = (): void => this.schedule()

  constructor(private readonly view: EditorView) {
    const doc = view.dom.ownerDocument
    this.style = doc.createElement('style')
    this.style.dataset.mdr = 'sticky-table-header'
    doc.head.appendChild(this.style)
    const RO = (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver
    this.ro = RO ? new RO(this.onResize) : null
    this.ro?.observe(view.dom)
    doc.defaultView?.addEventListener('resize', this.onResize)
    this.schedule()
  }

  /** A doc change may add, remove or widen tables. */
  update(): void {
    this.schedule()
  }

  private schedule(): void {
    if (this.frame !== null) return
    const win = this.view.dom.ownerDocument.defaultView
    if (!win) return
    this.frame = win.requestAnimationFrame(() => {
      this.frame = null
      this.run()
    })
  }

  private bindScroller(): HTMLElement | null {
    const sc = this.view.dom.isConnected ? scrollParent(this.view.dom) : null
    if (sc !== this.scroller) {
      this.scroller?.removeEventListener('scroll', this.onScroll)
      sc?.addEventListener('scroll', this.onScroll, { passive: true })
      this.scroller = sc
    }
    return sc
  }

  private tables(): Array<{ n: number; el: HTMLTableElement }> {
    const out: Array<{ n: number; el: HTMLTableElement }> = []
    const kids = this.view.dom.children
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i]!
      if (el.nodeName === 'TABLE') out.push({ n: i + 1, el: el as HTMLTableElement })
    }
    return out
  }

  private run(): void {
    const sc = this.bindScroller()
    const settled = sc !== null && Array.from(this.view.dom.children).every((el) => el.nodeName !== 'TABLE' || el.clientWidth > 0)
    if (!settled && this.waits-- > 0) this.schedule()
    if (!sc) return
    // A table not laid out yet (clientWidth 0) is left for a later frame. scrollWidth still reports the overflow of an
    // overflow: visible box, so a fitting table that grows past the column moves to the wide path on the next run.
    const tables = this.tables().filter((t) => t.el.clientWidth > 0)
    const fits = (t: { el: HTMLTableElement }): boolean => t.el.scrollWidth <= t.el.clientWidth + 1
    const fit = tables.filter(fits).map((t) => `${ROOT} > table:nth-child(${t.n})`)
    const fitCss = fit.length ? `${fit.join(',\n')} { overflow: visible; }\n` : ''
    // Wide tables only: the one straddling the top edge gets its header translated down to that edge.
    const top = sc.getBoundingClientRect().top + sc.clientTop
    let shift = ''
    for (const t of tables) {
      if (fits(t)) continue
      const head = t.el.querySelector('tr')
      if (!head) continue
      const box = t.el.getBoundingClientRect()
      if (box.top >= top || box.bottom <= top) continue
      // the header's natural top is the table's top (the translate is undone in the measurement)
      const hh = head.getBoundingClientRect().height
      const scrollbar = t.el.offsetHeight - t.el.clientHeight
      const by = Math.min(top - box.top, box.height - scrollbar - hh)
      if (by <= 0) continue
      shift = `${headCells(t.n)} { transform: translateY(${Math.round(by)}px); }\n`
      break
    }
    this.fitCss = fitCss
    this.shiftCss = shift
    this.write()
  }

  private write(): void {
    const css = this.fitCss + this.shiftCss
    if (this.style.textContent !== css) this.style.textContent = css
  }

  destroy(): void {
    const win = this.view.dom.ownerDocument.defaultView
    if (this.frame !== null) win?.cancelAnimationFrame(this.frame)
    this.scroller?.removeEventListener('scroll', this.onScroll)
    win?.removeEventListener('resize', this.onResize)
    this.ro?.disconnect()
    this.style.remove()
  }
}

/**
 * A client box that sits in a pinned header row, moved back to where that row sits unpinned (the top of its table).
 * Every anchor rect goes through rects.ts toContent, which calls this, so a comment on a header cell keeps its card
 * level with the header's real place in the document even when the rail lays out while the header is pinned.
 */
export function unstickBox<B extends { top: number; bottom: number; left: number }>(scope: ParentNode, r: B): B {
  if (typeof scope.querySelectorAll !== 'function') return r
  for (const table of Array.from(scope.querySelectorAll<HTMLElement>('.ProseMirror > table'))) {
    // the cells move, not the row: a sticky or translated <th> leaves its <tr> box where it was
    const head = table.querySelector('tr')?.firstElementChild
    if (!head || head.nodeName !== 'TH') continue
    const h = head.getBoundingClientRect()
    const t = table.getBoundingClientRect()
    const delta = h.top - t.top
    if (delta < 1) continue
    if (r.top < h.top - 1 || r.bottom > h.bottom + 1 || r.left < t.left - 1 || r.left > t.right + 1) continue
    return { ...r, top: r.top - delta, bottom: r.bottom - delta }
  }
  return r
}

/** The plugin view that pins each top-level table's header row while its table is on screen. */
export function stickyHeaderPlugin(): Plugin {
  return new Plugin({
    key: stickyHeaderKey,
    view(view) {
      const s = new StickyHeader(view)
      return {
        update: (v, prev) => {
          if (v.state.doc !== prev.doc) s.update()
        },
        destroy: () => s.destroy(),
      }
    },
  })
}
