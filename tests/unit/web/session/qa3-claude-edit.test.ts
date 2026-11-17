// tests/unit/web/session/qa3-claude-edit.test.ts (QA round 3, cli-handoff). When Claude edits a block directly
// (`mdr edit-block`, batch replace_block ...) the page text changes under the human's eyes with nothing said. The
// session raises a CLAUDE_EDITED notice from the doc-changed event (by: 'Claude', not an echo of this tab's own save),
// which the shell shows as "Claude changed N blocks." with a View history action. The Claude badge is untouched: a
// direct edit is work, not a reply (server/handoff/activity.ts).
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionNotice } from '../../../../shared/types'
import { fixture, tick, until, type Fixture } from './helpers'

const DOC = 'doc.md'
const MD = '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n'

let fx: Fixture | null = null
afterEach(async () => {
  await fx?.close()
  fx = null
})

async function openWithNotices(): Promise<{ notices: SessionNotice[]; session: Awaited<ReturnType<Fixture['open']>>['session'] }> {
  fx = await fixture({ file: DOC, markdown: MD })
  const { session, transport } = await fx.open({})
  await until(() => transport.openStreamCount() === 1)
  await tick(30)
  const notices: SessionNotice[] = []
  session.onNotice((n) => notices.push(n))
  return { notices, session }
}

describe('CLAUDE_EDITED (the change cue for a direct Claude edit)', () => {
  it('one block: "Claude changed 1 block."', async () => {
    const { notices } = await openWithNotices()
    await fx!.agent([{ op: 'replace_block', target: { quote: 'Third paragraph here.' }, markdown: 'Third paragraph, Claude meanwhile.' }])
    await until(() => notices.length >= 1, 3_000, 'CLAUDE_EDITED')
    expect(notices[0]).toMatchObject({ kind: 'info', code: 'CLAUDE_EDITED', text: 'Claude changed 1 block.' })
  })

  it('several blocks in one write: the count, plural', async () => {
    const { notices } = await openWithNotices()
    await fx!.agent([
      { op: 'replace_block', target: { quote: 'First paragraph here.' }, markdown: 'First, edited.' },
      { op: 'replace_block', target: { quote: 'Third paragraph here.' }, markdown: 'Third, edited.' },
    ])
    await until(() => notices.length >= 1, 3_000, 'CLAUDE_EDITED')
    expect(notices[0]).toMatchObject({ code: 'CLAUDE_EDITED', text: 'Claude changed 2 blocks.' })
  })

  it('a comment or a suggestion from Claude changes no bytes, so there is no change cue', async () => {
    const { notices } = await openWithNotices()
    await fx!.agent([
      { op: 'comment', quote: 'First paragraph here.', body: 'Which first?' },
      { op: 'suggest', quote: 'Second paragraph here.', replace: 'Second paragraph, suggested.' },
    ])
    await tick(300)
    expect(notices).toEqual([])
  })
})
