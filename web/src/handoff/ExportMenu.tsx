// web/src/handoff/ExportMenu.tsx. The top bar's Export menu: "Google Doc" or "Word file". Neither runs anything in the
// page: each one is a Send to Claude with a message saying what to make, so a person who never types a command gets
// the export through the same handoff (and the same paste fallback) as every other request. Claude does the work with
// `mdr export-gdoc` / `mdr export-docx` (skill: references/google-docs-and-word.md).
import { useEffect, useId, useRef, useState } from 'react'
import type { HandoffController } from './controller'
import './export.css'

export const EXPORT_MESSAGES = {
  gdoc: 'Please export this review to a new Google Doc with the open comments on it, and send me the link.',
  docx: 'Please export this review to a Word file (.docx) with the open comments on it, and tell me where it is.',
} as const

export function ExportMenu({ controller }: { controller: HandoffController }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const firstItem = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    firstItem.current?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pick = (kind: keyof typeof EXPORT_MESSAGES): void => {
    setOpen(false)
    controller.send(EXPORT_MESSAGES[kind])
  }
  return (
    <div className="mdr-export" ref={wrap}>
      <button
        type="button"
        className="mdr-button mdr-export-button"
        data-testid="mdr-export"
        aria-label="Export"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={id}
        title="Export with comments: Claude makes a Google Doc or a Word file"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        Export
      </button>
      {open ? (
        <div className="mdr-export-menu" id={id} role="menu" aria-label="Export with comments">
          <button type="button" role="menuitem" ref={firstItem} data-testid="mdr-export-gdoc" aria-label="Google Doc, a new doc with the comments" onClick={() => pick('gdoc')}>
            Google Doc
            <span className="mdr-export-hint" aria-hidden="true">New doc, comments included</span>
          </button>
          <button type="button" role="menuitem" data-testid="mdr-export-docx" aria-label="Word file, a .docx with the comments" onClick={() => pick('docx')}>
            Word file
            <span className="mdr-export-hint" aria-hidden="true">.docx with comments</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
