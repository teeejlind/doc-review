// tests/unit/web/handoff/qa3-unsent.test.ts (QA round 3, rail-ui 5).
//
// Send to Claude with a reply or new comment typed but not posted: the controller posts it first, hands over only
// once it went through, and says so (and sends nothing) when it didn't.
import { describe, expect, it } from 'vitest'
import { createFakeDocSession } from '../../../fakes/FakeDocSession'
import { createHandoffController } from '../../../../web/src/handoff/controller'
import { createToastStore } from '../../../../web/src/shell/toast-store'

function setup(unsent: { has(): boolean; post(): Promise<boolean> } | undefined) {
  const session = createFakeDocSession({ file: 'plan.md', root: '/work', review: { presence: { waiter: 'connected' } }, clipboard: null })
  const toasts = createToastStore()
  const controller = createHandoffController({ session, toasts, clipboard: null, ...(unsent ? { unsent } : {}) })
  const order: string[] = []
  const handoff = session.handoff.bind(session)
  session.handoff = (...a: Parameters<typeof session.handoff>) => {
    order.push('handoff')
    return handoff(...a)
  }
  return { session, toasts, controller, order }
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('Send with something typed but not posted', () => {
  it('posts it first and only then hands over', async () => {
    const s = setup({ has: () => true, post: async () => (s.order.push('post'), true) })
    s.controller.send()
    // not yet: the post comes first
    expect(s.order).toEqual(['post'])
    await settle()
    expect(s.order).toEqual(['post', 'handoff'])
    expect(s.controller.pending).toBe(0)
  })

  it('sends nothing, and says so, when the post fails', async () => {
    const s = setup({ has: () => true, post: async () => false })
    s.controller.send()
    await settle()
    expect(s.order).toEqual([])
    const t = s.toasts.list().find((x) => x.code === 'HANDOFF_UNPOSTED')
    expect(t?.kind).toBe('warn')
    expect(t?.text).toContain('nothing was sent')
  })

  it('a rejected post is the same failure', async () => {
    const s = setup({ has: () => true, post: () => Promise.reject(new Error('boom')) })
    s.controller.send()
    await settle()
    expect(s.order).toEqual([])
    expect(s.toasts.list().some((x) => x.code === 'HANDOFF_UNPOSTED')).toBe(true)
  })

  it('with nothing unsent, handoff() still runs synchronously inside the click (the clipboard gesture)', () => {
    const s = setup({ has: () => false, post: async () => true })
    s.controller.send()
    expect(s.order).toEqual(['handoff'])
  })
})
