// tests/unit/web/editor/statusBlock.test.ts (P2; CONTRACTS §12.12 B). The body status chip in the live editor: the
// collapsed chip with its phrases and meta, read-only while collapsed, expand by chip click (selection-only, so
// planSave stays []), editing when expanded saves through the normal paragraph path, forced open by suggestion marks
// and open highlights, re-derived after an external rewrite, and a thread inside a collapsed block reports the chip's
// rect.
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import { TESTID } from '../../../../shared/constants'
import type { EditorDebugHooks } from '../../../../shared/types'
import { statusCollapsed } from '../../../../web/src/editor/statusBlock'
import { fixtureText } from '../../core/status-header/corpus'
import { caret, find, labelInNameProblem, mount, press, saved, typeKeys, until, type Mounted } from './helpers'

let m: Mounted | null = null
afterEach(async () => {
  await m?.close()
  m = null
})

const DOC = fixtureText('syn__status-header.md')
const chip = (mm: Mounted): HTMLElement => mm.host.querySelector<HTMLElement>(`[data-testid="${TESTID.statusChip}"]`)!
const dbg = (): EditorDebugHooks => (globalThis as unknown as { __mdrDebug: EditorDebugHooks }).__mdrDebug

describe('status chip (§12.12 B)', () => {
  it('collapsed: a Status label, one pill per phrase, the other fields as meta; the block itself is hidden', async () => {
    m = await mount({ markdown: DOC })
    const c = chip(m)
    expect(c.dataset.expanded).toBe('false')
    expect([...c.querySelectorAll('.mdr-status-chip__pill')].map((p) => p.textContent)).toEqual(['draft only', 'needs Dana Reyes sign-off (legal)'])
    expect(c.querySelector('.mdr-status-chip__meta')!.textContent).toBe('Owner: TJ · Updated: 2026-10-15')
    expect(m.host.querySelector('.mdr-status-block.is-collapsed')).not.toBeNull()
    expect(statusCollapsed(m.view.state)).toBe(true)
  })

  it('QA3: the collapsed chip’s name contains its visible text (the label, every pill and the meta line; WCAG 2.5.3)', async () => {
    m = await mount({ markdown: DOC })
    expect(labelInNameProblem(chip(m))).toBeNull()
    expect(chip(m).getAttribute('aria-label')).toMatch(/Press Enter to edit/)
  })

  it('while collapsed the block is read-only: a join into it from the next block changes nothing', async () => {
    m = await mount({ markdown: '# T\n\n**Status:** draft only\n\nNext paragraph.\n' })
    caret(m.view, 'Next paragraph.', { at: 'start' })
    const before = m.view.state.doc
    press(m, 'Backspace')
    expect(m.view.state.doc.eq(before)).toBe(true)
    // a direct user step inside the block is refused too
    const r = find(m.view, 'draft only')
    m.view.dispatch(m.view.state.tr.insertText('X', r.from))
    expect(m.view.state.doc.eq(before)).toBe(true)
  })

  it('clicking the chip expands the block (selection only: planSave stays []); leaving the block collapses it', async () => {
    m = await mount({ markdown: DOC })
    chip(m).click()
    expect(statusCollapsed(m.view.state)).toBe(false)
    expect(chip(m).dataset.expanded).toBe('true')
    expect(m.host.querySelector('.mdr-status-block.is-collapsed')).toBeNull()
    expect(dbg().planSave()).toEqual([])
    caret(m.view, 'Body paragraph')
    expect(statusCollapsed(m.view.state)).toBe(true)
    expect(dbg().planSave()).toEqual([])
    expect(await saved(m)).toBe(DOC)
  })

  it('expanded, an edit takes the normal paragraph path: only that line changes on disk', async () => {
    m = await mount({ markdown: DOC })
    chip(m).click()
    const r = find(m.view, 'draft only')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.to)))
    typeKeys(m.view, ' (v2)')
    const out = await saved(m)
    const a = DOC.split('\n')
    const b = out.split('\n')
    expect(b.filter((l, i) => l !== a[i])).toEqual(['**Status:** draft only (v2) · needs Dana Reyes sign-off (legal)'])
    caret(m.view, 'Body paragraph')
    expect([...chip(m).querySelectorAll('.mdr-status-chip__pill')].map((p) => p.textContent)).toEqual(['draft only (v2)', 'needs Dana Reyes sign-off (legal)'])
  })

  it('a Suggesting-mode edit is tracked and keeps the chip forced open after the caret leaves', async () => {
    m = await mount({ markdown: DOC })
    m.bridge.setMode('suggesting')
    chip(m).click()
    const r = find(m.view, 'draft only')
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, r.to)))
    typeKeys(m.view, '!')
    caret(m.view, 'Body paragraph')
    expect(statusCollapsed(m.view.state)).toBe(false)
    expect(chip(m).dataset.expanded).toBe('true')
    expect(await saved(m)).toBe(DOC)
  })

  it('an open thread in the block forces it open; a resolved one leaves it collapsed and reports the chip rect', async () => {
    m = await mount({ markdown: DOC, claude: [{ op: 'comment', quote: 'needs Dana Reyes', body: 'Is this lane right?' }] })
    await until(() => m!.session.getReview().threads.length === 1)
    await until(() => !statusCollapsed(m!.view.state))
    const id = m.session.getReview().threads[0]!.id
    await m.session.resolve(id)
    await until(() => m!.session.getReview().threads[0]!.status === 'resolved')
    await until(() => statusCollapsed(m!.view.state))
    expect(m.bridge.getAnchorRects([id]).get(id)).not.toBeNull()
  })

  it('an external rewrite of the status line updates the chip', async () => {
    m = await mount({ markdown: DOC })
    await m.fx.agent([{ op: 'replace_block', target: { quote: 'draft only · needs Dana Reyes' }, markdown: '**Status:** approved per approvals/x.md (hash-matched)\n**Owner:** TJ' } as never])
    await until(() => chip(m!).textContent!.includes('approved per'))
    expect([...chip(m).querySelectorAll('.mdr-status-chip__pill')].map((p) => p.textContent)).toEqual(['approved per approvals/x.md (hash-matched)'])
  })
})
