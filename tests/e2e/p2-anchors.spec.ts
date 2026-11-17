// tests/e2e/p2-anchors.spec.ts (P2; CONTRACTS §14 P2 e2e "p2-anchors", §5.2, §5.4, §12.1, §12.6 step 6, §13 #37, #38,
// #80, #90, D45). Real selections and keystrokes in Chromium: deleting a highlighted span detaches its thread (read
// through getReview()), undo brings the text back and the next save reattaches it with its highlight; a selection
// from base text into a pending insertion maps to base text only, one wholly inside it targets the suggestion; a
// select-all over MAX_QUOTE_CHARS gives a long anchor whose thread highlights the whole span.
import { CONSTANTS } from '../../shared/types'
import { browserChoice } from '../helpers/browser'
import { MOD, openDoc, placeCaret, pressInEditor, summaries } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: ['basic.md'] })
test.skip(!BROWSER.available, BROWSER.reason)

type EP = import('../helpers/openEditor').EditorPage

async function threadOn(ed: EP, text: string, body: string): Promise<string> {
  await placeCaret(ed.page, text, 'select')
  const target = await ed.bridge((b) => b.getSelectionTarget())
  if (target?.kind !== 'anchor') throw new Error(`expected a text anchor, got ${JSON.stringify(target)}`)
  expect(target.anchor.quote).toBe(text)
  const r = await ed.session((s, a) => s.createThread(a.anchor, a.body), { anchor: target.anchor, body })
  return r.thread.id
}

const detached = (ed: EP, id: string): Promise<boolean | undefined> =>
  ed.session((s, t) => s.getReview().threads.find((x) => x.id === t)?.detached, id)

test('p2-anchors: delete a highlighted span → detached; undo → reattached and highlighted after the next save (§13 #37, #38)', async ({ page, editorPage: ed, tmpRoot }) => {
  const id = await threadOn(ed, 'reviewed every quarter', 'Is quarterly right?')
  const hl = ed.testid('highlight', { 'data-thread': id })
  await expect(hl.first()).toBeVisible()
  await expect(hl.first()).toHaveText('reviewed every quarter')
  expect(await detached(ed, id)).toBe(false)

  // TJ deletes exactly the highlighted text with the keyboard
  await placeCaret(page, 'reviewed every quarter', 'select')
  await page.keyboard.press('Backspace')
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('The member rate is .')
  await expect.poll(() => detached(ed, id)).toBe(true)
  await expect(hl).toHaveCount(0)
  const log = tmpRoot.readSidecar('basic.md') as Array<{ type?: string; by?: string; thread?: string }>
  expect(log.some((e) => e.type === 'thread.detach' && e.by === 'TJ' && e.thread === id)).toBe(true)

  // undo restores the text; the next save's server re-resolution reattaches; the decoration is rebuilt
  await pressInEditor(ed, `${MOD}+KeyZ`)
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('The member rate is reviewed every quarter.')
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('The member rate is reviewed every quarter.')
  await expect.poll(() => detached(ed, id), { timeout: 10_000 }).toBe(false)
  await expect(hl.first()).toBeVisible()
  await expect(hl.first()).toHaveText('reviewed every quarter')
  expect(await ed.bridge((b, t) => b.getAnchorRects([t]).get(t) ?? null, id)).not.toBeNull()
})

test('p2-anchors: a selection ending inside a pending insertion anchors base text only; one wholly inside it targets the suggestion (§12.1, §13 #80)', async ({ page, editorPage: ed }) => {
  await ed.bridge((b) => b.setMode('suggesting'))
  await placeCaret(page, 'Grow the waitlist', 'end')
  await page.keyboard.type(' ASAP')
  await expect(ed.testid('suggestion', { 'data-kind': 'ins' }).first()).toHaveText(' ASAP')
  await ed.session((s) => s.flush())
  await expect.poll(async () => (await summaries(ed)).filter((s) => s.by === 'TJ').length).toBe(1)
  const [sum] = await summaries(ed)
  await expect.poll(() => ed.session((s, sid) => s.getReview().suggestions.some((x) => x.id === sid), sum!.id)).toBe(true)

  // from "the waitlist" (base) into the middle of " ASAP" (inserted)
  const ok = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let base: Text | null = null
    let ins: Text | null = null
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (!base && n.data.includes('Grow the waitlist')) base = n
      if (!ins && n.data === ' ASAP') ins = n
    }
    if (!base || !ins) return false
    root.focus()
    window.getSelection()!.setBaseAndExtent(base, base.data.indexOf('the waitlist'), ins, 3)
    return true
  })
  expect(ok).toBe(true)
  await page.waitForTimeout(60)
  const t1 = await ed.bridge((b) => b.getSelectionTarget())
  expect(t1?.kind).toBe('anchor')
  if (t1?.kind !== 'anchor') throw new Error('unreachable')
  expect(t1.anchor.quote).toBe('the waitlist')
  expect(t1.quote).toBe('the waitlist')
  expect(t1.anchor.quote).not.toContain('AS')

  // wholly inside the insertion → that suggestion's thread
  await placeCaret(page, 'ASA', 'select')
  const t2 = await ed.bridge((b) => b.getSelectionTarget())
  expect(t2).toMatchObject({ kind: 'inside-suggestion', suggestion: sum!.id })
  const thread = await ed.session((s, sid) => s.getReview().suggestions.find((x) => x.id === sid)?.thread, sum!.id)
  if (t2?.kind !== 'inside-suggestion') throw new Error('unreachable')
  expect(t2.thread).toBe(thread)
})

test.describe('long anchor', () => {
  test.use({ fixtureFiles: [] })
  const para = (i: number): string =>
    `Paragraph ${i} carries enough words about member rates, terms and minimums to make the document long, so a select-all crosses the quote cap.`
  const LONG = ['# Long', '', ...Array.from({ length: 90 }, (_, i) => [para(i + 1), '']).flat()].join('\n')

  test('p2-anchors: select-all over MAX_QUOTE_CHARS gives a long anchor; the thread highlights the whole span (§5.2, §13 #90, D45)', async ({ page, server, tmpRoot }) => {
    expect(LONG.length).toBeGreaterThan(CONSTANTS.MAX_QUOTE_CHARS + 1000)
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'long.md', content: LONG })
    await page.getByText('Paragraph 3 carries').click()
    await page.keyboard.press(`${MOD}+KeyA`)
    await page.waitForTimeout(80)
    const target = await ed.bridge((b) => b.getSelectionTarget())
    if (target?.kind !== 'anchor') throw new Error(`expected a text anchor, got ${JSON.stringify(target?.kind)}`)
    const a = target.anchor
    expect(a.span).toBeGreaterThan(CONSTANTS.MAX_QUOTE_CHARS)
    expect(a.quote).toHaveLength(CONSTANTS.LONG_QUOTE_EDGE_CHARS)
    expect(a.tail).toHaveLength(CONSTANTS.LONG_QUOTE_EDGE_CHARS)
    expect(a.quote.startsWith('Long')).toBe(true)
    expect(a.tail!.endsWith(`${para(90)}`.slice(-40))).toBe(true)
    // the extent covers the whole selection, beyond the viewport
    expect(target.extent.bottom - target.extent.top).toBeGreaterThan(await page.evaluate(() => document.getElementById('mdr-scroll')!.clientHeight))

    const r = await ed.session((s, an) => s.createThread(an, 'Whole doc: tighten this'), a)
    const id = r.thread.id
    expect(r.thread.detached).toBe(false)
    const hl = ed.testid('highlight', { 'data-thread': id })
    await expect(hl.first()).toBeVisible()
    // every paragraph, first to last, is inside the highlight
    const covered = await page.evaluate((tid) => {
      const pm = document.querySelector('#mdr-editor-host .ProseMirror')!
      const ps = [...pm.querySelectorAll('p')]
      return ps.map((p) => p.querySelector(`[data-thread="${tid}"]`) !== null)
    }, id)
    expect(covered).toHaveLength(90)
    expect(covered.every(Boolean)).toBe(true)
    expect((await page.locator('#mdr-editor-host h1').first().locator(`[data-thread="${id}"]`).count())).toBeGreaterThan(0)
    await expect.poll(() => ed.session((s, t) => s.getReview().threads.find((x) => x.id === t)?.anchor, id)).toMatchObject({ kind: 'text', span: a.span })
  })
})
