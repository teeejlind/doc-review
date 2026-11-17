// QA pass 4 #5: the check mark on a suggestion card is "Resolve thread", which read as Accept and left the change
// pending on a card tagged Resolved. A card holding a pending suggestion has no resolve control (Accept and Reject are
// the only paths); comment-only cards keep it. (A decided suggestion thread is auto-resolved, so it never offered the control.)
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRail, suggestionFor } from './mount'
import type { Thread } from '../../../../shared/types'
import { thread } from '../shell/helpers'

afterEach(cleanup)

function suggestionThread(status: 'pending') {
  const t: Thread = { ...thread(1, { block: 2, by: 'Claude' }), kind: 'suggestion' }
  const s = suggestionFor(t, 10, { status })
  t.suggestions = [s.id]
  return { t, s }
}

describe('Resolve on a suggestion card (QA pass 4 #5)', () => {
  it('a card with a pending suggestion has no resolve control, but keeps Accept and Reject', async () => {
    const { t, s } = suggestionThread('pending')
    const m = await mountRail({ threads: [t], suggestions: [s] })
    expect(m.all('cardResolve', m.card(t.id))).toHaveLength(0)
    expect(m.all('accept', m.card(t.id))).toHaveLength(1)
    expect(m.all('reject', m.card(t.id))).toHaveLength(1)
  })

  it('a comment-only card keeps its resolve control', async () => {
    const t = thread(2, { block: 2 })
    const m = await mountRail({ threads: [t] })
    expect(m.all('cardResolve', m.card(t.id))).toHaveLength(1)
  })
})
