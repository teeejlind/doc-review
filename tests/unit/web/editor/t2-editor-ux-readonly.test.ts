// tests/unit/web/editor/t2-editor-ux-readonly.test.ts (T2 editor-ux, Pass 4 #23): in a read-only document (a second tab)
// Cmd+Opt+M with nothing focused runs the registered Comment shortcut, which comments on the selection (the rail's window
// listener would open a whole-document comment).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

describe('#23: a read-only tab', () => {
  const chord = (): KeyboardEvent =>
    new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })

  it('Cmd+Opt+M with nothing focused runs the registered Comment shortcut, and the event is handled', async () => {
    m = await mount({ markdown: 'Plain words here.\n' })
    const run = vi.fn(() => true)
    m.bridge.registerShortcut({ key: 'Mod-Alt-m', run })
    m.ed.setEditable(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
    const e = chord()
    document.body.dispatchEvent(e)
    expect(run).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('an editable document leaves it to the focused editor and the page after it, as before', async () => {
    m = await mount({ markdown: 'Plain words here.\n' })
    const run = vi.fn(() => true)
    m.bridge.registerShortcut({ key: 'Mod-Alt-m', run })
    ;(document.activeElement as HTMLElement | null)?.blur()
    const e = chord()
    document.body.dispatchEvent(e)
    expect(run).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('with something else focused (an input), a read-only page does not take the chord', async () => {
    m = await mount({ markdown: 'Plain words here.\n' })
    const run = vi.fn(() => true)
    m.bridge.registerShortcut({ key: 'Mod-Alt-m', run })
    m.ed.setEditable(false)
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    input.dispatchEvent(chord())
    expect(run).not.toHaveBeenCalled()
    input.remove()
  })
})
