// tests/unit/web/editor/qa4-editor.test.ts (QA round 4, editor fixer). Each describe names the Pass 4 finding it pins.
// Bar: in Suggesting mode, Accept writes exactly the Markdown the same keystrokes produce in Editing mode.
import { afterEach, describe, expect, it } from 'vitest'
import { caret, find, mount, press, select, typeKeys, until, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

/** Run `keys` on a fresh mount in `mode`; in Suggesting, accept every pending suggestion; return the saved file. */
async function outcome(markdown: string, mode: 'editing' | 'suggesting', keys: (mm: Mounted) => void): Promise<string> {
  const mm = await mount({ markdown })
  m = mm
  if (mode === 'suggesting') mm.bridge.setMode('suggesting')
  keys(mm)
  await mm.session.flush()
  if (mode === 'suggesting') {
    await until(() => mm.session.getReview().suggestions.some((s) => s.status === 'pending')).catch(() => undefined)
    for (const s of mm.session.getReview().suggestions.filter((x) => x.status === 'pending')) await mm.bridge.accept(s.id)
    await mm.session.flush()
  }
  const out = mm.fx.root.read('doc.md')
  await mm.close()
  m = null
  return out
}
const both = async (md: string, keys: (mm: Mounted) => void): Promise<{ edit: string; sugg: string }> => ({
  edit: await outcome(md, 'editing', keys),
  sugg: await outcome(md, 'suggesting', keys),
})

describe('Pass 4 #6 (reject)', () => {
  it('rejecting the lift and join leaves the file as it was', async () => {
    const md = '# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n'
    m = await mount({ markdown: md })
    m.bridge.setMode('suggesting')
    caret(m.view, 'Gamma item', { at: 'start' })
    press(m, 'Backspace')
    press(m, 'Backspace')
    await m.session.flush()
    await until(() => m!.session.getReview().suggestions.some((s) => s.status === 'pending'))
    for (const s of m.session.getReview().suggestions) await m.bridge.reject(s.id)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe(md)
  })
})

describe('Pass 4 #6: lift out of a list and join (Backspace twice at a bullet start)', () => {
  it('first item of a list joins onto the heading above', async () => {
    const r = await both('# T\n\n- Alpha item\n- Beta item\n\nTail.\n', (mm) => {
      caret(mm.view, 'Alpha item', { at: 'start' })
      press(mm, 'Backspace')
      press(mm, 'Backspace')
    })
    expect(r.edit).toBe('# TAlpha item\n\n- Beta item\n\nTail.\n')
    expect(r.sugg).toBe(r.edit)
  })
  it('one Backspace (the lift alone) matches Editing mode', async () => {
    const r = await both('# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n', (mm) => {
      caret(mm.view, 'Gamma item', { at: 'start' })
      press(mm, 'Backspace')
    })
    expect(r.sugg).toBe(r.edit)
  })
  it('list', async () => {
    const r = await both('# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n', (mm) => {
      caret(mm.view, 'Gamma item', { at: 'start' })
      press(mm, 'Backspace')
      press(mm, 'Backspace')
    })
    expect(r.sugg).toBe(r.edit)
  })
  it('quote', async () => {
    const r = await both('# T\n\n> Quote one\n\nTail.\n', (mm) => {
      caret(mm.view, 'Quote one', { at: 'start' })
      press(mm, 'Backspace')
      press(mm, 'Backspace')
    })
    expect(r.sugg).toBe(r.edit)
  })
})

describe('Pass 4 #7: Enter just before a space, then typing', () => {
  const P = '# T\n\nFirst sentence is here. Second sentence follows it. Third one ends.\n\nTail.\n'
  it('typed text lands on the new line and Accept writes what Editing writes', async () => {
    const r = await both(P, (mm) => {
      caret(mm.view, 'is here.')
      press(mm, 'Enter')
      typeKeys(mm.view, 'New paragraph text')
    })
    expect(r.sugg).toBe(r.edit)
  })
  it('the typed text sits in the new block, and Cmd+Z takes it back in one step', async () => {
    m = await mount({ markdown: P })
    m.bridge.setMode('suggesting')
    caret(m.view, 'is here.')
    press(m, 'Enter')
    typeKeys(m.view, 'New paragraph text')
    const $c = m.view.state.selection.$from
    expect($c.parent.textContent.split('\u200b').join('')).toBe('New paragraph textSecond sentence follows it. Third one ends.')
    expect(m.view.state.doc.child(1).textContent).not.toContain('New')
    m.ed.runAction('undo', m.view)
    expect(m.view.state.doc.textContent).not.toContain('New paragraph')
  })
})

describe('Pass 4 #8: Editing mode, deleting a middle list item with Backspace', () => {
  const keys3 = (mm: Mounted): void => {
    const r = find(mm.view, 'Second step')
    select(mm.view, r.from, r.to)
    press(mm, 'Backspace') // the text
    press(mm, 'Backspace') // the bullet comes off
    press(mm, 'Backspace') // the empty line goes
  }
  it('a numbered list stays one list and keeps counting', async () => {
    m = await mount({ markdown: '1. First step\n2. Second step\n3. Third step\n4. Fourth step\n' })
    keys3(m)
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe('1. First step\n2. Third step\n3. Fourth step\n')
  })
  it('a bullet list stays one list', async () => {
    m = await mount({ markdown: '# T\n\n- alpha\n- beta\n- gamma\n\nTail.\n' })
    const r = find(m.view, 'beta')
    select(m.view, r.from, r.to)
    press(m, 'Backspace')
    press(m, 'Backspace')
    press(m, 'Backspace')
    await m.session.flush()
    expect(m.fx.root.read('doc.md')).toBe('# T\n\n- alpha\n- gamma\n\nTail.\n')
  })
})

describe('Pass 4 #9 and #24: Suggesting, deleting a list item', () => {
  const LIST = '## Goals\n\n- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ\n\nTail.\n'
  const whole = (mm: Mounted, text: string): void => {
    const r = find(mm.view, text)
    select(mm.view, r.from, r.to)
  }
  /** Editing needs one more Backspace than Suggesting: it empties the item, lifts it, then removes the empty line. */
  const run = async (md: string, text: string, backspaces: [number, number]): Promise<{ edit: string; sugg: string }> => {
    const edit = await outcome(md, 'editing', (mm) => {
      whole(mm, text)
      for (let i = 0; i < backspaces[0]; i++) press(mm, 'Backspace')
    })
    const sugg = await outcome(md, 'suggesting', (mm) => {
      whole(mm, text)
      for (let i = 0; i < backspaces[1]; i++) press(mm, 'Backspace')
    })
    return { edit, sugg }
  }
  it('select the item text, Backspace twice, Accept: the middle item is gone', async () => {
    const r = await run(LIST, 'Ship the explainer page', [3, 2])
    expect(r.edit).toBe('## Goals\n\n- Grow the waitlist\n- Publish the FAQ\n\nTail.\n')
    expect(r.sugg).toBe(r.edit)
  })
  it('the last item, and the first', async () => {
    const last = await run(LIST, 'Publish the FAQ', [3, 2])
    expect(last.sugg).toBe(last.edit)
    expect(last.edit).toBe('## Goals\n\n- Grow the waitlist\n- Ship the explainer page\n\nTail.\n')
    const first = await run(LIST, 'Grow the waitlist', [3, 2])
    expect(first.sugg).toBe(first.edit)
  })
  it('one Backspace leaves the same empty bullet Editing leaves', async () => {
    const r = await run(LIST, 'Ship the explainer page', [1, 1])
    expect(r.sugg).toBe(r.edit)
  })
  it('a selection from the end of the item above through the item deletes it in one Backspace', async () => {
    const edit = await outcome(LIST, 'editing', (mm) => {
      select(mm.view, find(mm.view, 'Grow the waitlist').to, find(mm.view, 'Ship the explainer page').to)
      press(mm, 'Backspace')
    })
    const sugg = await outcome(LIST, 'suggesting', (mm) => {
      select(mm.view, find(mm.view, 'Grow the waitlist').to, find(mm.view, 'Ship the explainer page').to)
      press(mm, 'Backspace')
    })
    expect(edit).toBe('## Goals\n\n- Grow the waitlist\n- Publish the FAQ\n\nTail.\n')
    expect(sugg).toBe(edit)
  })
  it('a triple-click selection (item start to the next item start) and Delete', async () => {
    const keys = (mm: Mounted): void => {
      select(mm.view, find(mm.view, 'Ship the explainer page').from, find(mm.view, 'Publish the FAQ').from)
      press(mm, 'Delete')
    }
    const edit = await outcome(LIST, 'editing', keys)
    const sugg = await outcome(LIST, 'suggesting', keys)
    expect(edit).toBe('## Goals\n\n- Grow the waitlist\n- Publish the FAQ\n\nTail.\n')
    expect(sugg).toBe(edit)
  })
  it('Enter at the end of a bullet, then Backspace twice, leaves the file as it was (middle and last item)', async () => {
    for (const item of ['Ship the explainer page', 'Publish the FAQ']) {
      const keys = (mm: Mounted): void => {
        caret(mm.view, item)
        press(mm, 'Enter')
        press(mm, 'Backspace')
        press(mm, 'Backspace')
      }
      const edit = await outcome(LIST, 'editing', keys)
      const sugg = await outcome(LIST, 'suggesting', keys)
      expect(edit).toBe(LIST)
      expect(sugg).toBe(LIST)
    }
  })
  it('Delete at the end of an item merges the next item, as Editing does', async () => {
    const keys = (mm: Mounted): void => {
      caret(mm.view, 'Grow the waitlist')
      press(mm, 'Delete')
    }
    const edit = await outcome(LIST, 'editing', keys)
    const sugg = await outcome(LIST, 'suggesting', keys)
    expect(edit).toContain('Ship the explainer page')
    expect(edit).not.toBe(LIST)
    expect(sugg).toBe(edit)
  })
  it('striking the text and then removing the item is one card', async () => {
    m = await mount({ markdown: LIST })
    m.bridge.setMode('suggesting')
    whole(m, 'Ship the explainer page')
    press(m, 'Backspace')
    press(m, 'Backspace')
    await m.session.flush()
    await until(() => m!.session.getReview().suggestions.length > 0)
    const pending = m.session.getReview().suggestions.filter((s) => s.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.proposed).toBe('- Grow the waitlist\n- Publish the FAQ')
  })
})
