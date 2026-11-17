// web/src/shell/ShellLayout.tsx (P3; CONTRACTS §12.0.1).
//
// The §12.0.1 DOM, once, for every page state: the live document (Shell) and the empty / error states (which render
// their message in the doc column). The host ids P2 mounts into, #mdr-scroll and the rail are always present, so
// the page keeps one shape whatever happened at boot. After the scroll container: the narrow-mode sheet host and the
// window-level overlays (toasts, history panel, prompt modal).
import type { ReactNode, Ref } from 'react'
import { TESTID } from '../../../shared/constants'

export interface ShellLayoutProps {
  /** An empty or error state: no document, so nothing for the top bar to hold. It stays in the frame (§12.0.1), hidden. */
  bare?: boolean
  topbarRef?: Ref<HTMLElement>
  toolbarRef?: Ref<HTMLDivElement>
  scrollRef?: Ref<HTMLDivElement>
  editorHostRef?: Ref<HTMLDivElement>
  railRef?: Ref<HTMLElement>
  /** P3's top-bar items (Comment button, save chip, Claude badge, Send, history). */
  actions?: ReactNode
  /** The file strip (where the document lives), the top bar's last row: inside the header, so its measured height covers it. */
  strip?: ReactNode
  /** The banner slot's content (§12.14). */
  banner?: ReactNode
  /** Rendered in the doc column before #mdr-editor-host (empty and error states). */
  docBefore?: ReactNode
  /** The rail's content (header panel and cards). */
  rail?: ReactNode
  /** Narrow mode's bottom sheet renders into this host (outside the scroll container and the hidden rail). */
  sheetRef?: Ref<HTMLDivElement>
  /** Window-level layers: toasts, the history panel, the prompt modal. */
  overlays?: ReactNode
}

export function ShellLayout(p: ShellLayoutProps) {
  return (
    <>
      <header className="mdr-topbar" data-testid={TESTID.topbar} data-quiet="false" hidden={p.bare} ref={p.topbarRef}>
        <div id="mdr-toolbar-host" ref={p.toolbarRef} />
        <div className="mdr-topbar-actions">{p.actions}</div>
        {p.strip}
      </header>
      <div className="mdr-banner-slot">{p.banner}</div>
      <div id="mdr-scroll" className="mdr-scroll" data-testid={TESTID.scroll} ref={p.scrollRef}>
        <div className="mdr-canvas">
          <main className="mdr-doc-col">
            {p.docBefore}
            <div id="mdr-editor-host" ref={p.editorHostRef} />
          </main>
          <aside className="mdr-rail" aria-label="Comments" data-testid={TESTID.rail} ref={p.railRef}>
            {p.rail}
          </aside>
        </div>
      </div>
      <div className="mdr-sheet-host" ref={p.sheetRef} />
      {p.overlays}
    </>
  )
}
