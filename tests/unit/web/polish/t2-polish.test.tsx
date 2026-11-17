// tests/unit/web/polish/t2-polish.test.tsx (T2 polish, Pass 4 items #12, #38). Copy and chrome checks that need the
// rail or the real page; the layout and focus findings live in tests/e2e/t2-polish-*.spec.ts.
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRail } from '../threads/mount'
import { thread } from '../shell/helpers'

function setMeta(tags: Record<string, string>): void {
  for (const [name, content] of Object.entries(tags)) {
    const el = document.createElement('meta')
    el.name = name
    el.content = content
    el.dataset.test = 'polish'
    document.head.appendChild(el)
  }
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  for (const el of Array.from(document.head.querySelectorAll('meta[data-test="polish"]'))) el.remove()
})

describe('T2 polish #12: the reply box is named by the display name, not the stored actor id', () => {
  it('a thread the user started: the reply box reads "Reply to <display name>"', async () => {
    setMeta({ 'mdr-user-name': 'Ana Díaz', 'mdr-user-source': 'git' })
    const t = thread(1, { block: 2 })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    expect(reply.getAttribute('aria-label')).toBe('Reply to Ana Díaz')
  })

  it('a thread Claude started: the reply box reads "Reply to Claude"', async () => {
    const t = thread(1, { block: 2, by: 'Claude' })
    const m = await mountRail({ threads: [t] })
    const reply = m.byTestId('cardReply', {}, m.card(t.id)) as HTMLTextAreaElement
    expect(reply.getAttribute('aria-label')).toBe('Reply to Claude')
  })
})

describe('T2 polish #38: Escape closes the Review settings popover from its gear button', () => {
  it('focus on the gear: Escape closes the popover and focus goes back to the gear', async () => {
    const m = await mountRail()
    const gear = m.byTestId('railSettings') as HTMLButtonElement
    await act(async () => gear.click())
    const popover = m.$<HTMLElement>('.mdr-rail-settings')
    expect(popover.hidden).toBe(false)
    act(() => gear.focus())
    fireEvent.keyDown(gear, { key: 'Escape' })
    expect(popover.hidden).toBe(true)
    expect(gear.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(gear)
  })
})
