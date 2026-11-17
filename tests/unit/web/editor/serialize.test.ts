// tests/unit/web/editor/serialize.test.ts (P2; CONTRACTS §12.13 "Tests": serialize goldens). Each construct the
// toolbar can make, applied to a known doc through its toolbar button, pinned to the exact saved markdown (core
// stringify defaults: `-` bullets, `-` rules, `*` emphasis, `**` strong, fenced code, unpadded tables). The untouched
// neighbouring block keeps its bytes in every case.
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { TESTID } from '../../../../shared/constants'
import { caret, find, mount, saved, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const MD = 'Keep *this* line as_is.\n\nChange the middle word here.\n'
const KEEP = 'Keep *this* line as_is.\n\n'

function button(mm: Mounted, action: string): HTMLButtonElement {
  return mm.toolbarHost.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.toolbarButton}"][data-action="${action}"]`)!
}

async function apply(o: { select?: string; caretIn?: string; actions: string[] }): Promise<string> {
  m = await mount({ markdown: MD })
  if (o.select) {
    const r = find(m.view, o.select)
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.from, r.to)))
  } else caret(m.view, o.caretIn ?? 'middle')
  for (const a of o.actions) button(m, a).click()
  return saved(m)
}

const GOLDENS: Array<{ name: string; select?: string; actions: string[]; want: string }> = [
  { name: 'bold', select: 'middle', actions: ['bold'], want: 'Change the **middle** word here.\n' },
  { name: 'italic', select: 'middle', actions: ['italic'], want: 'Change the *middle* word here.\n' },
  { name: 'strikethrough', select: 'middle', actions: ['strike'], want: 'Change the ~~middle~~ word here.\n' },
  { name: 'inline code', select: 'middle', actions: ['code'], want: 'Change the `middle` word here.\n' },
  { name: 'bold + italic', select: 'middle', actions: ['bold', 'italic'], want: 'Change the ***middle*** word here.\n' },
  { name: 'heading 1', actions: ['heading', 'heading-1'], want: '# Change the middle word here.\n' },
  { name: 'heading 2', actions: ['heading', 'heading-2'], want: '## Change the middle word here.\n' },
  { name: 'heading 3', actions: ['heading', 'heading-3'], want: '### Change the middle word here.\n' },
  { name: 'bulleted list', actions: ['bullet'], want: '- Change the middle word here.\n' },
  { name: 'numbered list', actions: ['ordered'], want: '1. Change the middle word here.\n' },
  { name: 'task list', actions: ['task'], want: '- [ ] Change the middle word here.\n' },
  { name: 'blockquote', actions: ['blockquote'], want: '> Change the middle word here.\n' },
  { name: 'code block', actions: ['code-block'], want: '```\nChange the middle word here.\n```\n' },
  { name: 'horizontal rule (below the block)', actions: ['hr'], want: 'Change the middle word here.\n\n---\n' },
]

describe('serialize goldens (§12.13)', () => {
  for (const g of GOLDENS) {
    it(g.name, async () => {
      expect(await apply({ ...(g.select ? { select: g.select } : {}), actions: g.actions })).toBe(KEEP + g.want)
    })
  }

  it('toggling back to normal text restores the original bytes', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'middle')
    button(m, 'heading').click()
    button(m, 'heading-2').click()
    button(m, 'heading').click()
    button(m, 'heading-0').click()
    expect(await saved(m)).toBe(MD)
  })

  it('a bulleted list toggled to numbered and back, and a task toggled off', async () => {
    m = await mount({ markdown: MD })
    caret(m.view, 'middle')
    button(m, 'bullet').click()
    button(m, 'ordered').click()
    expect(await saved(m)).toBe(`${KEEP}1. Change the middle word here.\n`)
    button(m, 'bullet').click()
    expect(await saved(m)).toBe(`${KEEP}- Change the middle word here.\n`)
    button(m, 'task').click()
    expect(await saved(m)).toBe(`${KEEP}- [ ] Change the middle word here.\n`)
    button(m, 'task').click()
    expect(await saved(m)).toBe(`${KEEP}- Change the middle word here.\n`)
  })
})
