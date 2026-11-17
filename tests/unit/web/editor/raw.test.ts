// tests/unit/web/editor/raw.test.ts (P2; CONTRACTS §12.13 "Raw blocks and raw HTML", D44, §3.4). The raw popover
// commit through loadRun (raw stays raw; raw edited into plain markdown becomes a paragraph; the op is that block
// alone), the inline-HTML chip edit (one paragraph re-serialized), the popover's test ids, and the Suggesting-mode
// blocks (the popover opens, Save is disabled and raises SUGGEST_MODE_BLOCKED).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TESTID } from '../../../../shared/constants'
import { labelInNameProblem, mount, saved, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

// a link-reference definition block is a raw `gap` block on every loader (remark-inline-links removes it); unused,
// so editing it changes no other block's meaning
const RAW = 'Intro paragraph.\n\n[docs]: https://docs.example.com\n\nOutro paragraph.\n'
// day-0 applyBlockOps verifies a run with loadRun(run + the doc's defs), and loadRun merges a definition-only run with
// those defs, so a gap edit can't verify on save until P1's M1 splice (contract-changes/P2.md); the on-disk half of
// that case turns on when the DAY0-STUB marker leaves core/splice/apply.ts
const APPLY_IS_STUB = readFileSync(join(process.cwd(), 'core/splice/apply.ts'), 'utf8').includes('DAY0-STUB')

const q = <T extends Element = HTMLElement>(mm: Mounted, testid: string, extra = ''): T | null => mm.host.querySelector<T>(`[data-testid="${testid}"]${extra}`)
const popover = (mm: Mounted): HTMLElement | null => q(mm, TESTID.rawPopover)
const source = (mm: Mounted): HTMLTextAreaElement => popover(mm)!.querySelector<HTMLTextAreaElement>(`[data-testid="${TESTID.popoverField}"][data-field="source"]`)!
const action = (mm: Mounted, a: string): HTMLButtonElement => popover(mm)!.querySelector<HTMLButtonElement>(`[data-testid="${TESTID.popoverAction}"][data-action="${a}"]`)!

describe('raw blocks (§12.13, D44)', () => {
  it('render read-only with data-reason; click opens the popover with the exact source; Cancel changes nothing', async () => {
    m = await mount({ markdown: RAW })
    const block = q(m, TESTID.rawBlock)!
    expect(block.dataset.reason).toBe('gap')
    expect(block.textContent).toBe('[docs]: https://docs.example.com')
    block.click()
    expect(popover(m)).not.toBeNull()
    expect(source(m).value).toBe('[docs]: https://docs.example.com')
    action(m, 'cancel').click()
    expect(popover(m)).toBeNull()
    expect(await saved(m)).toBe(RAW)
  })

  it('QA3: a raw block’s name contains the text it shows (WCAG 2.5.3)', async () => {
    m = await mount({ markdown: RAW })
    const block = q(m, TESTID.rawBlock)!
    expect(labelInNameProblem(block)).toBeNull()
    // named by its source; what it is and how to open it is its description
    expect(block.hasAttribute('aria-label')).toBe(false)
    expect(block.title).toMatch(/^Raw source block \(gap\): press Enter to edit/)
    expect(block.textContent).toBe('[docs]: https://docs.example.com')
  })

  it('clicking a raw block selects it as a node: the comment target is a block anchor (§12.13, §5.3)', async () => {
    m = await mount({ markdown: RAW })
    q(m, TESTID.rawBlock)!.click()
    expect(m.bridge.getSelectionTarget()?.kind).toBe('block')
  })

  it('Enter on the focused block opens the popover too', async () => {
    m = await mount({ markdown: RAW })
    q(m, TESTID.rawBlock)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(popover(m)).not.toBeNull()
  })

  it('Save: an edit that still classifies as raw stays a raw block; only that block changes on disk', async () => {
    m = await mount({ markdown: RAW })
    q(m, TESTID.rawBlock)!.click()
    source(m).value = '[docs]: https://docs2.example.com'
    action(m, 'save').click()
    expect(popover(m)).toBeNull()
    expect(q(m, TESTID.rawBlock)).not.toBeNull()
    expect(m.view.state.doc.child(1).type.name).toBe('raw_block')
    expect(m.view.state.doc.child(1).attrs.value).toBe('[docs]: https://docs2.example.com')
    if (!APPLY_IS_STUB) expect(await saved(m)).toBe('Intro paragraph.\n\n[docs]: https://docs2.example.com\n\nOutro paragraph.\n')
  })

  it('Save: raw edited into plain markdown becomes the parsed nodes (a paragraph), exactly what load() gives', async () => {
    m = await mount({ markdown: RAW })
    q(m, TESTID.rawBlock)!.click()
    source(m).value = 'Now *plain* text.'
    action(m, 'save').click()
    expect(m.view.state.doc.child(1).type.name).toBe('paragraph')
    expect(q(m, TESTID.rawBlock)).toBeNull()
    expect(await saved(m)).toBe('Intro paragraph.\n\nNow *plain* text.\n\nOutro paragraph.\n')
    // the next plan is empty: the live doc equals load() of the saved text
    expect((globalThis as unknown as { __mdrDebug: { planSave(): unknown[] } }).__mdrDebug.planSave()).toEqual([])
  })

  it('Save is one undoable step', async () => {
    m = await mount({ markdown: RAW })
    q(m, TESTID.rawBlock)!.click()
    source(m).value = 'Replaced.'
    action(m, 'save').click()
    m.ed.runAction('undo', m.view)
    expect(await saved(m)).toBe(RAW)
  })

  it('Suggesting mode: the popover opens, Save is aria-disabled and raises SUGGEST_MODE_BLOCKED', async () => {
    m = await mount({ markdown: RAW })
    m.bridge.setMode('suggesting')
    q(m, TESTID.rawBlock)!.click()
    expect(popover(m)).not.toBeNull()
    expect(action(m, 'save').getAttribute('aria-disabled')).toBe('true')
    source(m).value = 'changed'
    action(m, 'save').click()
    expect(m.notices.map((n) => n.code)).toContain('SUGGEST_MODE_BLOCKED')
    expect(await saved(m)).toBe(RAW)
  })
})

describe('inline HTML chips (§12.13, §0.2 item 10)', () => {
  const HTML = 'Intro.\n\nA paragraph with <span class="tag">inline</span> HTML.\n\nOutro.\n'

  it('render the tag source as a non-editable chip; Save sets the value and re-serializes only that paragraph', async () => {
    m = await mount({ markdown: HTML })
    const chips = [...m.host.querySelectorAll<HTMLElement>(`[data-testid="${TESTID.inlineHtml}"]`)]
    expect(chips.map((c) => c.textContent)).toEqual(['<span class="tag">', '</span>'])
    expect(chips[0]!.getAttribute('contenteditable')).toBe('false')
    chips[0]!.click()
    expect(source(m).value).toBe('<span class="tag">')
    source(m).value = '<span class="note">'
    action(m, 'save').click()
    expect(await saved(m)).toBe('Intro.\n\nA paragraph with <span class="note">inline</span> HTML.\n\nOutro.\n')
  })

  it('Suggesting mode: value edits are blocked; deleting text that contains a chip is tracked', async () => {
    m = await mount({ markdown: HTML })
    m.bridge.setMode('suggesting')
    m.host.querySelector<HTMLElement>(`[data-testid="${TESTID.inlineHtml}"]`)!.click()
    expect(action(m, 'save').getAttribute('aria-disabled')).toBe('true')
    action(m, 'save').click()
    expect(m.notices.map((n) => n.code)).toContain('SUGGEST_MODE_BLOCKED')
    action(m, 'cancel').click()
    // a direct value change is refused by the D14 filter as well
    let pos = -1
    m.view.state.doc.descendants((n, p) => {
      if (pos < 0 && n.type.name === 'html') pos = p
    })
    const before = m.view.state.doc
    m.view.dispatch(m.view.state.tr.setNodeAttribute(pos, 'value', '<b>'))
    expect(m.view.state.doc.eq(before)).toBe(true)
    // deleting a run that contains a chip is ordinary inline content: tracked
    const para = m.view.state.doc.child(1)
    let start = 0
    m.view.state.doc.forEach((_n, off, i) => {
      if (i === 1) start = off + 1
    })
    m.view.dispatch(m.view.state.tr.delete(start + 'A paragraph with '.length, start + para.content.size - ' HTML.'.length))
    expect([...m.bridge.getSuggestionSummaries().values()].some((s) => s.kind === 'delete')).toBe(true)
    expect(await saved(m)).toBe(HTML)
  })
})
