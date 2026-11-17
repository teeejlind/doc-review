// tests/unit/web/handoff/copy.test.ts (P3; CONTRACTS §8.5 badge copy table, §12.10 toasts, §14 P3 unit tests:
// "toast copy for each (clientDecision, delivery, copied) combination and state, including the mismatch case" and
// "badge copy for every ClaudeActivity.state × delivery").
import { describe, expect, it } from 'vitest'
import type { ClaudeActivity, HandoffOutcome } from '../../../../shared/types'
import { COPIED_TEXT } from '../../../../web/src/handoff/controller'
import { BADGE_TEXT, badgeCopy, badgeLabel, failedToast, HANDOFF_TEXT, handoffReaction, offlineToast, undeliveredToast } from '../../../../web/src/handoff/copy'

type Combo = Pick<HandoffOutcome, 'clientDecision' | 'delivery' | 'copied' | 'nothingNew'>
const decisions: Combo['clientDecision'][] = ['waiter', 'clipboard']
const deliveries: Combo['delivery'][] = ['waiter', 'latched', 'clipboard']

describe('handoffReaction: every (clientDecision, delivery, copied) combination (§12.10 step 3, step 5)', () => {
  const expected = (c: Combo): string => {
    if (c.clientDecision === 'clipboard') return c.copied ? 'toast:HANDOFF_COPIED' : 'modal'
    return { waiter: 'toast:HANDOFF_SENT', latched: 'toast:HANDOFF_LATCHED', clipboard: 'toast:HANDOFF_MISMATCH' }[c.delivery]
  }
  for (const clientDecision of decisions)
    for (const delivery of deliveries)
      for (const copied of [true, false]) {
        const c: Combo = { clientDecision, delivery, copied }
        it(`(${clientDecision}, ${delivery}, copied=${copied}) → ${expected(c)}`, () => {
          const r = handoffReaction(c)
          expect('modal' in r ? 'modal' : `toast:${r.toast.code}`).toBe(expected(c))
        })
      }

  it('(waiter, waiter): "Sent to Claude." with no Copy message', () => {
    const r = handoffReaction({ clientDecision: 'waiter', delivery: 'waiter', copied: false })
    expect(r).toEqual({ toast: { code: 'HANDOFF_SENT', kind: 'info', text: 'Sent to Claude.', copyPrompt: false } })
  })

  it('(waiter, latched): the queued copy, nothing copied', () => {
    const r = handoffReaction({ clientDecision: 'waiter', delivery: 'latched', copied: false })
    expect('toast' in r && r.toast.text).toBe('Claude is busy right now. It will see your changes when it finishes.')
    expect('toast' in r && r.toast.copyPrompt).toBe(false)
  })

  it('(clipboard, clipboard, copied): says the prompt was copied', () => {
    const r = handoffReaction({ clientDecision: 'clipboard', delivery: 'clipboard', copied: true })
    expect('toast' in r && r.toast.text).toBe('Claude isn’t listening. Message copied: paste it into your Claude conversation.')
    expect('toast' in r && r.toast.copyPrompt).toBe(false)
  })

  it('the mismatch case (waiter, clipboard): never claims a copy, offers Copy message', () => {
    const r = handoffReaction({ clientDecision: 'waiter', delivery: 'clipboard', copied: false })
    expect('toast' in r).toBe(true)
    if (!('toast' in r)) return
    expect(r.toast.text).toBe('Claude isn’t listening anymore. Copy this message and paste it into your Claude conversation.')
    expect(r.toast.text.toLowerCase()).not.toContain('copied')
    expect(r.toast.copyPrompt).toBe(true)
    expect(r.toast.kind).toBe('warn')
  })

  it('a clipboard decision whose write was refused opens the modal, whatever the delivery', () => {
    for (const delivery of deliveries) expect(handoffReaction({ clientDecision: 'clipboard', delivery, copied: false })).toEqual({ modal: true })
  })

  it('"copied" appears only when the in-gesture write succeeded', () => {
    for (const clientDecision of decisions)
      for (const delivery of deliveries)
        for (const copied of [true, false]) {
          const r = handoffReaction({ clientDecision, delivery, copied })
          if ('toast' in r && /copied/i.test(r.toast.text)) expect(copied).toBe(true)
        }
  })
})

describe('Send with nothing new (QA3)', () => {
  it('says so quietly, whatever the click did: no modal, no copy claim, no Copy message button', () => {
    const text = 'Nothing new to send yet. Add a comment or edit first.'
    for (const clientDecision of decisions)
      for (const delivery of deliveries)
        for (const copied of [true, false]) {
          const r = handoffReaction({ clientDecision, delivery, copied, nothingNew: true })
          expect(r, `${clientDecision}/${delivery}/${copied}`).toEqual({ toast: { code: 'HANDOFF_NOTHING_NEW', kind: 'info', text, copyPrompt: false } })
        }
    expect(HANDOFF_TEXT.nothingNew).toBe(text)
  })
})

describe('the SSE and failure toasts (§12.10 steps 4 and 6)', () => {
  it('undelivered: "Claude didn’t pick this up" with Copy message', () => {
    expect(undeliveredToast()).toEqual({ code: 'HANDOFF_UNDELIVERED', kind: 'warn', text: HANDOFF_TEXT.undelivered, copyPrompt: true })
    expect(HANDOFF_TEXT.undelivered).toBe('Claude didn’t pick this up')
  })

  it('server unreachable after an in-gesture copy: says so, no button', () => {
    expect(offlineToast(true)).toEqual({ code: 'HANDOFF_OFFLINE', kind: 'warn', text: 'Lost connection to the review page. Reload to reconnect. Your last edits aren’t saved yet. Message copied.', copyPrompt: false })
  })

  it('server unreachable with nothing copied: no "copied", offers Copy message', () => {
    const t = offlineToast(false)
    expect(t.text).toBe('Lost connection to the review page. Reload to reconnect. Your last edits aren’t saved yet.')
    expect(t.copyPrompt).toBe(true)
  })

  it('a refusal with a reason says the reason', () => {
    expect(failedToast('This file is read-only right now.')).toMatchObject({ code: 'HANDOFF_FAILED', kind: 'error', text: 'Couldn’t send to Claude: This file is read-only right now.' })
  })
})

describe('badgeCopy: every ClaudeActivity.state × delivery (§8.5, normative)', () => {
  const act = (state: ClaudeActivity['state'], delivery?: ClaudeActivity['delivery'], unread = 0): Pick<ClaudeActivity, 'state' | 'delivery' | 'unreadFromClaude'> => ({
    state,
    unreadFromClaude: unread,
    ...(delivery ? { delivery } : {}),
  })

  it('idle → no badge', () => {
    expect(badgeCopy(act('idle'))).toBeNull()
    expect(badgeCopy(act('idle', undefined, 4))).toBeNull()
  })

  it('waiting-pickup / waiter → "Sent to Claude"', () => {
    expect(badgeCopy(act('waiting-pickup', 'waiter'))).toEqual({ text: 'Sent to Claude', copyPrompt: false, pulse: false, count: null })
  })

  it('waiting-pickup / latched → the queued copy', () => {
    expect(badgeCopy(act('waiting-pickup', 'latched'))!.text).toBe('Queued for Claude')
  })

  it('waiting-pickup / clipboard → waiting for the paste, with Copy message', () => {
    expect(badgeCopy(act('waiting-pickup', 'clipboard'))).toEqual({ text: 'Waiting for you to paste it into Claude', copyPrompt: true, pulse: false, count: null })
  })

  it('working → "Claude is working" with the pulsing dot, for any delivery', () => {
    for (const d of [undefined, 'waiter', 'latched', 'clipboard'] as const) expect(badgeCopy(act('working', d))).toEqual({ text: 'Claude is working', copyPrompt: false, pulse: true, count: null })
  })

  it('replied → "Claude replied" plus the unread count', () => {
    expect(badgeCopy(act('replied', undefined, 3))).toEqual({ text: 'Claude replied', copyPrompt: false, pulse: false, count: 3 })
    expect(badgeLabel(badgeCopy(act('replied', undefined, 3))!)).toBe('Claude replied, 3 unread. Show the first')
    expect(badgeCopy(act('replied', undefined, 0))!.count).toBe(0)
    expect(badgeLabel(badgeCopy(act('replied', undefined, 0))!)).toBe('Claude replied')
  })

  it('every state × delivery has copy (no gap in the table)', () => {
    for (const s of ['idle', 'waiting-pickup', 'working', 'replied'] as const)
      for (const d of [undefined, 'waiter', 'latched', 'clipboard'] as const) {
        const c = badgeCopy(act(s, d))
        if (s === 'idle') expect(c).toBeNull()
        else expect(Object.values(BADGE_TEXT)).toContain(c!.text)
      }
  })
})

describe('plain language for a colleague who installed a plugin (QA3)', () => {
  const JARGON = /waiter|\bmdr\b|session|\bthe chat\b/i

  it('no toast or badge text names plumbing: no waiter, no mdr, no session, no "the chat"', () => {
    for (const t of [...Object.values(HANDOFF_TEXT), ...Object.values(BADGE_TEXT), COPIED_TEXT]) expect(t).not.toMatch(JARGON)
  })

  it('the three reactions that used to say it now say what to do', () => {
    expect(HANDOFF_TEXT.latched).toBe('Claude is busy right now. It will see your changes when it finishes.')
    expect(HANDOFF_TEXT.copied).toBe('Claude isn’t listening. Message copied: paste it into your Claude conversation.')
    expect(HANDOFF_TEXT.mismatch).toBe('Claude isn’t listening anymore. Copy this message and paste it into your Claude conversation.')
    expect(COPIED_TEXT).toBe('Message copied: paste it into your Claude conversation.')
  })

  it('every badge row fits the badge (it caps at 300px and ellipsizes, which cut "Queued: … its waiter rec…" at 1440px)', () => {
    for (const t of Object.values(BADGE_TEXT)) expect(t.length, t).toBeLessThanOrEqual(40)
  })
})
