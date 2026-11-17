// tests/unit/web/identity/identity.test.tsx (generalization pass). The page shows the human by the display name the
// server injects (<meta name="mdr-user-name">), never the stored actor id 'TJ'; "You" without the tag. The copied
// prompt names them for Claude ("the user" when the name is only the default) and uses mdr-cmd. The rendered cards
// (thread, draft, suggestion rows) are covered on the real stack by tests/e2e/gen-identity.spec.ts.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildClipboardPrompt } from '../../../../shared/handoff-prompt'
import { agentCmd, personName, promptIdentity, promptWho, userName } from '../../../../web/src/identity'
import { authorLabel } from '../../../../web/src/threads/model'
import { actorLabel, ACTOR_LABEL } from '../../../../web/src/history/diff-view'
import { stateLine } from '../../../../web/src/threads/suggestion-view'
import { emptyCommand } from '../../../../web/src/shell/EmptyState'

function setMeta(tags: Record<string, string>): void {
  for (const [name, content] of Object.entries(tags)) {
    const el = document.createElement('meta')
    el.name = name
    el.content = content
    el.dataset.test = 'identity'
    document.head.appendChild(el)
  }
}

afterEach(() => {
  cleanup()
  for (const el of Array.from(document.head.querySelectorAll('meta[data-test="identity"]'))) el.remove()
})

describe('web identity', () => {
  it('no tags: "You", the "mdr" command, and the prompt keeps its original wording', () => {
    expect(userName()).toBe('You')
    expect(agentCmd()).toBe('mdr')
    expect(personName('TJ')).toBe('You')
    expect(promptWho()).toBeUndefined()
    expect(promptIdentity()).toEqual({})
    expect(buildClipboardPrompt({ file: 'a.md', abs: '/r/a.md', root: '/r', round: null, ...promptIdentity() }).split('\n')[0]).toBe('[doc-review] TJ sent `a.md` back to you (new items).')
  })

  it('a display name replaces "TJ" everywhere the human is labelled', () => {
    setMeta({ 'mdr-user-name': 'Ana Díaz', 'mdr-user-source': 'git' })
    expect(authorLabel('TJ')).toBe('Ana Díaz')
    expect(authorLabel('Claude')).toBe('Claude')
    expect(authorLabel('external')).toBe('Someone outside the editor')
    expect(actorLabel('TJ')).toBe('Ana Díaz')
    expect(ACTOR_LABEL.TJ).toBe('Ana Díaz')
    expect(actorLabel('system')).toBe('mdr')
    expect(stateLine({ status: 'accepted', decidedBy: 'TJ' })!.tag).toBe('Accepted by Ana Díaz')
  })

  it('the copied prompt names the user for Claude and uses mdr-cmd', () => {
    setMeta({ 'mdr-user-name': 'Ana', 'mdr-user-source': 'config', 'mdr-cmd': 'npx -y mdr' })
    const line = buildClipboardPrompt({ file: 'a.md', abs: '/r/a.md', root: '/r', round: null, ...promptIdentity() }).split('\n')
    expect(line[0]).toBe('[doc-review] Ana sent `a.md` back to you (new items).')
    expect(line[1]).toBe('Run: npx -y mdr pending "/r/a.md" --root "/r"')
  })

  it('the default "You" reads as "the user" in the prompt, and the empty state’s command to copy names mdr-cmd', () => {
    setMeta({ 'mdr-user-name': 'You', 'mdr-user-source': 'default', 'mdr-cmd': 'mdr2' })
    expect(promptWho()).toBe('the user')
    expect(userName()).toBe('You')
    expect(emptyCommand('FILE_NOT_FOUND', 'notes/a.md')).toBe('mdr2 open notes/a.md')
    expect(emptyCommand('FILE_NOT_FOUND', 'my notes/a b.md')).toBe('mdr2 open "my notes/a b.md"')
    expect(emptyCommand('PROTECTED_ROOT', 'approvals/x.md')).toBeNull()
  })
})
