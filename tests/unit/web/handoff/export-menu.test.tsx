// tests/unit/web/handoff/export-menu.test.tsx. The top bar's Export menu (web/src/handoff/ExportMenu.tsx): each item is a
// Send to Claude with a message naming the export; the menu opens and closes like a menu (Escape, outside click).
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandoffController } from '../../../../web/src/handoff/controller'
import { EXPORT_MESSAGES, ExportMenu } from '../../../../web/src/handoff/ExportMenu'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const fakeController = (): { c: HandoffController; send: ReturnType<typeof vi.fn> } => {
  const send = vi.fn()
  return { c: { send } as unknown as HandoffController, send }
}

describe('ExportMenu', () => {
  it('Google Doc and Word file each send Claude a request for that export', () => {
    const { c, send } = fakeController()
    const r = render(<ExportMenu controller={c} />)
    const button = r.getByTestId('mdr-export')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(r.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Google DocNew doc, comments included', 'Word file.docx with comments'])
    expect(document.activeElement).toBe(r.getByTestId('mdr-export-gdoc'))
    fireEvent.click(r.getByTestId('mdr-export-gdoc'))
    expect(send).toHaveBeenCalledWith(EXPORT_MESSAGES.gdoc)
    expect(r.queryByRole('menu')).toBeNull()
    fireEvent.click(button)
    fireEvent.click(r.getByTestId('mdr-export-docx'))
    expect(send).toHaveBeenLastCalledWith(EXPORT_MESSAGES.docx)
    expect(EXPORT_MESSAGES.gdoc).toMatch(/Google Doc/)
    expect(EXPORT_MESSAGES.docx).toMatch(/Word file \(\.docx\)/)
  })

  it('Escape and an outside click close it without sending', () => {
    const { c, send } = fakeController()
    const r = render(<div><p data-testid="out">x</p><ExportMenu controller={c} /></div>)
    fireEvent.click(r.getByTestId('mdr-export'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(r.queryByRole('menu')).toBeNull()
    fireEvent.click(r.getByTestId('mdr-export'))
    fireEvent.mouseDown(r.getByTestId('out'))
    expect(r.queryByRole('menu')).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})
