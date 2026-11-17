// tests/e2e/p3-threads.spec.ts (P3; CONTRACTS §5.2, §6.3, §6.8, §11.4, §11.5, §12.9, §12.15, §14 P3 E2E "p3-threads",
// §13 rows 37, 38, 72, 84, 90).
//
// The threads UI in a real browser. Before P2 lands this runs on the fake P2 modules:
// `MDR_FAKE_EDITOR=1 npm run e2e -- tests/e2e/p3-threads.spec.ts`. Selections are made as DOM selections (both
// directions), which the fake editor and ProseMirror both read. Every element is located by its §12.15 test id.
//
// Fake-editor limit: the fake renders a highlight only for an anchor inside one paragraph, so a multi-paragraph
// comment lands in Detached there; the assertions for those cases check that the thread was created with TJ's
// anchor and body (with the real editor it is positioned like any other).
import type { Locator, Page } from '@playwright/test'
import { CONSTANTS, TESTID } from '../../shared/constants'
import type { AgentOp, ThreadId } from '../../shared/types'
import type { WebClient } from '../helpers/webClient'
import { openEditor, type EditorPage } from '../helpers/openEditor'
import { expect, test, type CliHelper } from './fixtures'
import { inViewport, openRailSettings, P3_SERVER_KIND, railDoc, railSettled, selectText } from './fixtures/p3'

const FILE = 'threads.md'
test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: FILE })

const sel = (key: keyof typeof TESTID, attrs: Record<string, string> = {}): string =>
  `[data-testid="${TESTID[key]}"]` + Object.entries(attrs).map(([k, v]) => `[${k}="${v}"]`).join('')

async function open(page: Page, port: number): Promise<EditorPage> {
  await page.setViewportSize({ width: 1440, height: 900 })
  const ed = await openEditor(page, { port, file: FILE })
  await railSettled(page)
  return ed
}

/**
 * Posts into the composer once it has focus (the rail focuses it after the layout frame that placed its card), then
 * lets the write settle: the fake editor re-renders its DOM when the review state comes back, which would drop a
 * selection made in the meantime (ProseMirror keeps its text nodes, so this only matters on the fakes).
 */
async function post(page: Page, body: string): Promise<void> {
  await expect(page.locator(`${sel('cardReply')}:focus`)).toHaveCount(1)
  await page.keyboard.type(body)
  await page.keyboard.press('ControlOrMeta+Enter')
  // posted: the composer either went away (new comment) or emptied (reply)
  await expect
    .poll(() => page.evaluate((id) => (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.testid === id ? document.activeElement.value : ''), TESTID.cardReply))
    .toBe('')
  await railSettled(page, 400)
}

/** The whole-document dock posts with a plain Enter (Cmd+Enter is a newline there). */
async function postDoc(page: Page, body: string): Promise<void> {
  const box = page.locator(sel('docComposerInput'))
  await expect(box).toBeFocused()
  await page.keyboard.type(body)
  await page.keyboard.press('Enter')
  await expect(box).toHaveValue('')
  await railSettled(page, 400)
}

async function threadByBody(wc: WebClient, body: string): Promise<{ id: ThreadId; anchor: unknown }> {
  let found: { id: ThreadId; anchor: unknown } | undefined
  await expect
    .poll(async () => {
      const r = await wc.review()
      const t = r.threads.find((x) => x.messages.some((m) => m.body === body))
      found = t ? { id: t.id, anchor: t.anchor } : undefined
      return !!t
    })
    .toBe(true)
  return found!
}

async function seed(cli: CliHelper, ops: AgentOp[]): Promise<Array<{ thread?: ThreadId; suggestion?: string }>> {
  const r = await cli.batch(FILE, { ops })
  expect(r.ok, r.stdout + r.stderr).toBe(true)
  return (JSON.parse(r.stdout) as { results: Array<{ thread?: ThreadId; suggestion?: string }> }).results
}

const cardOf = (ed: EditorPage, id: string): Locator => ed.testid('card', { 'data-thread': id })

test.describe('p3-threads: creating comments (§11.4, R2.1)', () => {
  test.beforeEach(async ({ tmpRoot, server }) => {
    void server
    tmpRoot.write(FILE, railDoc(60))
  })

  for (const backward of [false, true]) {
    test(`1 word, 1 sentence and 3 paragraphs via the floating button (${backward ? 'right-to-left' : 'left-to-right'})`, async ({ page, server, webClient }) => {
      const ed = await open(page, server.port)
      const cases = [
        { from: 'tranche', body: `one word ${backward}` },
        { from: 'Paragraph 5 talks about the collateral and why it matters for marker5x.', body: `one sentence ${backward}` },
        { from: 'Paragraph 6 talks', to: 'Paragraph 8 talks about the ledger', body: `three paragraphs ${backward}` },
      ]
      for (const c of cases) {
        await selectText(page, { from: c.from, ...(c.to ? { to: c.to } : {}), backward })
        const btn = ed.testid('floatingComment')
        await expect(btn).toBeVisible()
        expect(await inViewport(page, sel('floatingComment'))).toBe(true)
        await btn.click()
        const draft = page.locator(`${sel('card')}[data-draft="true"]`)
        await expect(draft).toHaveAttribute('data-active', 'true')
        await expect(draft.locator(sel('cardReply'))).toBeFocused()
        await post(page, c.body)
        const t = await threadByBody(webClient, c.body)
        expect((t.anchor as { kind: string }).kind).toBe('text')
        await expect(draft).toHaveCount(0)
        if (!c.to) await expect(cardOf(ed, t.id)).toHaveAttribute('data-active', 'true')
      }
    })
  }

  test('a selection taller than the viewport: the floating button stays on screen at its start, middle and end; fully off screen it hides and the top bar button works', async ({ page, server, webClient }) => {
    const ed = await open(page, server.port)
    await selectText(page, { from: 'Paragraph 1 talks', to: 'Paragraph 30 talks about the waterfall' })
    const geo = await page.evaluate(() => {
      const sc = document.getElementById('mdr-scroll')!
      const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect()
      const c = sc.getBoundingClientRect()
      return { top: r.top - c.top + sc.scrollTop, bottom: r.bottom - c.top + sc.scrollTop, h: sc.clientHeight }
    })
    expect(geo.bottom - geo.top).toBeGreaterThan(geo.h)
    for (const scrollTop of [geo.top + 200, (geo.top + geo.bottom) / 2 - geo.h / 2, geo.bottom - geo.h + 100]) {
      await page.evaluate((y) => {
        document.getElementById('mdr-scroll')!.scrollTop = y
      }, scrollTop)
      await railSettled(page, 50)
      await expect(ed.testid('floatingComment')).toBeVisible()
      expect(await inViewport(page, sel('floatingComment'))).toBe(true)
    }
    // the bottom position: comment from here
    await ed.testid('floatingComment').click()
    await post(page, 'tall selection')
    await threadByBody(webClient, 'tall selection')

    // a selection scrolled fully off screen: no floating button; the top bar's Comment works
    await selectText(page, { from: 'marker55x' })
    await page.evaluate(() => {
      document.getElementById('mdr-scroll')!.scrollTop = 0
    })
    await railSettled(page, 50)
    await expect(ed.testid('floatingComment')).toBeHidden()
    const top = ed.testid('commentButton')
    await expect(top).toBeEnabled()
    const before = await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)
    await top.click()
    await railSettled(page)
    // the draft sits at its off-screen anchor: the pill points down, and typing scrolls nothing
    await expect(ed.testid('offscreenPill')).toBeVisible()
    await expect(ed.testid('offscreenPill')).toHaveAttribute('data-direction', 'down')
    await post(page, 'off-screen selection')
    expect(await page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)).toBe(before)
    const t = await threadByBody(webClient, 'off-screen selection')
    expect((t.anchor as { quote: string }).quote).toBe('marker55x')
  })

  test('select-all over 10,000 characters: a long anchor, and the card shows head … tail (row 90)', async ({ page, server, webClient }) => {
    const ed = await open(page, server.port)
    await selectText(page, { from: 'Rail check', to: 'Paragraph 59 talks' })
    await ed.testid('commentButton').click()
    const draft = page.locator(`${sel('card')}[data-draft="true"]`)
    await expect(draft.locator('.mdr-card-quote')).toHaveText(/^Rail check.* … .*Paragraph 59 talks$/)
    await post(page, 'whole thing')
    const t = await threadByBody(webClient, 'whole thing')
    const a = t.anchor as { quote: string; tail?: string; span?: number }
    expect(a.quote).toHaveLength(CONSTANTS.LONG_QUOTE_EDGE_CHARS)
    expect(a.tail).toHaveLength(CONSTANTS.LONG_QUOTE_EDGE_CHARS)
    expect(a.span!).toBeGreaterThan(CONSTANTS.MAX_QUOTE_CHARS)
  })

  test('Cmd+Opt+M: a caret in a word comments on the word; a caret elsewhere opens the whole-doc composer', async ({ page, server, webClient }) => {
    const ed = await open(page, server.port)
    await selectText(page, { from: 'collateral', collapseAt: 'start' })
    await page.keyboard.press('ControlOrMeta+Alt+KeyM')
    const draft = page.locator(`${sel('card')}[data-draft="true"]`)
    await expect(draft.locator('.mdr-card-quote')).toHaveText('collateral')
    await post(page, 'word at the caret')
    expect(((await threadByBody(webClient, 'word at the caret')).anchor as { quote: string }).quote).toBe('collateral')

    await selectText(page, { from: 'marker5x.', collapseAt: 'end' })
    await page.keyboard.press('ControlOrMeta+Alt+KeyM')
    // a caret in no word: the whole-document dock at the foot of the rail gets the focus
    await expect(ed.testid('docComposerInput')).toBeFocused()
    await postDoc(page, 'about the whole doc')
    const t = await threadByBody(webClient, 'about the whole doc')
    expect((t.anchor as { kind: string }).kind).toBe('doc')
    // listed under the header's "On the document" fold
    await expect(ed.testid('railHeader').getByRole('button', { name: /^On the document \(1\)/ })).toBeVisible()
  })

  test('the rail header’s Comment on document button', async ({ page, server, webClient }) => {
    const ed = await open(page, server.port)
    await ed.testid('docComment').click()
    await postDoc(page, 'header doc comment')
    const t = await threadByBody(webClient, 'header doc comment')
    expect((t.anchor as { kind: string }).kind).toBe('doc')
  })
})

test.describe('p3-threads: working a thread (R2.3, R2.5)', () => {
  let ids: Array<{ thread?: ThreadId; suggestion?: string }> = []
  test.beforeEach(async ({ tmpRoot, cli, server }) => {
    void server
    tmpRoot.write(FILE, railDoc(36))
    ids = await seed(cli, [
      { op: 'comment', quote: 'marker2x', body: 'Claude on paragraph 2.' },
      { op: 'comment', quote: 'marker12x', body: 'Claude on paragraph 12.' },
      { op: 'comment', quote: 'marker24x', body: 'Claude on paragraph 24.' },
      { op: 'suggest', quote: 'about the borrower and why it matters for marker3x', replace: 'about the named borrower and why it matters for marker3x', reason: 'Name them.' },
    ])
  })

  test('reply, edit and delete own, resolve, show-resolved, reopen', async ({ page, server, webClient }) => {
    const ed = await open(page, server.port)
    const t = ids[0]!.thread!
    const card = cardOf(ed, t)
    // reply on Claude's thread
    await card.locator(sel('cardReply')).click()
    await expect(card).toHaveAttribute('data-active', 'true')
    await post(page, 'My reply.')
    await expect(card.locator(sel('message', { 'data-by': 'TJ' }))).toContainText('My reply.')
    // edit it
    const mine = card.locator(sel('message', { 'data-by': 'TJ' }))
    await mine.locator(sel('cardEdit')).click()
    const box = mine.locator(sel('cardReply'))
    await box.fill('My reply, edited.')
    await mine.locator(sel('cardSubmit')).click()
    await expect(mine).toContainText('My reply, edited.')
    await expect(mine).toContainText('(edited)')
    // Claude's message has no edit/delete
    await expect(card.locator(sel('message', { 'data-by': 'Claude' })).locator(sel('cardEdit'))).toHaveCount(0)
    // delete it
    await mine.locator(sel('cardDelete')).click()
    await expect(mine).toContainText('Comment deleted')
    // resolve → hidden; show resolved → back with Reopen; reopen
    await card.locator(sel('cardResolve')).click()
    await expect(card).toHaveCount(0)
    await openRailSettings(page)
    await expect(ed.testid('showResolved')).toHaveAttribute('aria-checked', 'false')
    await ed.testid('showResolved').click()
    await expect(ed.testid('showResolved')).toHaveAttribute('aria-checked', 'true')
    await expect(card).toContainText('Resolved')
    await card.locator(sel('cardReopen')).click()
    await expect(card.locator(sel('cardResolve'))).toBeVisible()
    await ed.testid('showResolved').click()
    await expect(card).toBeVisible()
    expect((await webClient.review()).threads.find((x) => x.id === t)!.status).toBe('open')
  })

  test('next / previous buttons scroll the anchor to 30% and activate the card', async ({ page, server }) => {
    const ed = await open(page, server.port)
    await ed.testid('navNext').click()
    await railSettled(page)
    const first = page.locator(`${sel('card')}[data-active="true"]`)
    await expect(first).toHaveCount(1)
    await ed.testid('navNext').click()
    await railSettled(page)
    const active = await page.locator(`${sel('card')}[data-active="true"]`).getAttribute('data-thread')
    const frac = await page.evaluate((id) => {
      const sc = document.getElementById('mdr-scroll')!
      const hl = document.querySelector(`[data-testid="mdr-highlight"][data-thread="${id}"], [data-testid="mdr-suggestion"]`)!
      return (hl.getBoundingClientRect().top - sc.getBoundingClientRect().top) / sc.clientHeight
    }, active)
    expect(frac).toBeGreaterThan(0.2)
    expect(frac).toBeLessThan(0.4)
    await ed.testid('navPrev').click()
    await railSettled(page)
    expect(await page.locator(`${sel('card')}[data-active="true"]`).getAttribute('data-thread')).not.toBe(active)
  })

  test('highlight ↔ card focus, both ways (R2.5)', async ({ page, server }) => {
    const ed = await open(page, server.port)
    const t = ids[1]!.thread!
    await page.evaluate(() => {
      document.getElementById('mdr-scroll')!.scrollTop = 1200
    })
    await railSettled(page, 50)
    await ed.testid('highlight', { 'data-thread': t }).click()
    await expect(cardOf(ed, t)).toHaveAttribute('data-active', 'true')
    const other = ids[2]!.thread!
    await page.evaluate(() => {
      document.getElementById('mdr-scroll')!.scrollTop = 3000
    })
    await railSettled(page, 50)
    await cardOf(ed, other).locator('.mdr-card-head').click()
    await expect(ed.testid('highlight', { 'data-thread': other })).toHaveAttribute('data-active', 'true')
    await expect(ed.testid('highlight', { 'data-thread': t })).toHaveAttribute('data-active', 'false')
  })

  test('a suggestion card: per-record accept with its hunks; a resolved thread with a pending suggestion stays visible (§6.8, row 84)', async ({ page, server, cli }) => {
    const sugThread = ids[3]!.thread!
    await seed(cli, [{ op: 'resolve', thread: sugThread }])
    const ed = await open(page, server.port)
    const card = cardOf(ed, sugThread)
    await expect(ed.testid('showResolved')).toHaveAttribute('aria-checked', 'false')
    await expect(card).toBeVisible()
    await card.locator('.mdr-card-head').click()
    await expect(card).toContainText('Resolved')
    const row = card.locator(sel('suggestionItem', { 'data-suggestion': ids[3]!.suggestion! }))
    await expect(row).toHaveAttribute('data-status', 'pending')
    await expect(row.locator('ins')).toContainText('named')
    await row.locator(sel('accept')).click()
    // decided and resolved with nothing pending: the thread hides
    await expect(card).toHaveCount(0)
  })

  test('"Shown as a diff" (SCHEMA) stays at its block; "Can’t place this inline" (BASE_NOT_FOUND) lists in the header (§6.3, row 72)', async ({ page, server, cli }) => {
    const more = await seed(cli, [{ op: 'suggest', quote: 'about the waterfall and why it matters for marker6x', replace: 'about the payment waterfall and why it matters for marker6x' }])
    const ed = await open(page, server.port)
    const hasFake = await page.evaluate(() => typeof (window as unknown as { __mdrFake?: { bridge?: { setSuggestionSummaries?: unknown } } }).__mdrFake?.bridge?.setSuggestionSummaries === 'function')
    test.skip(!hasFake, 'with the real editor these come from p2-decisions’ code-block and table-row fixtures (P2 merge)')
    const a = ids[3]!.suggestion!
    const b = more[0]!.suggestion!
    await page.evaluate(
      ([a, b]) => {
        const fake = (window as unknown as { __mdrFake: { bridge: { setSuggestionSummaries(m: Map<string, unknown>): void; emitLayout(r: string): void } } }).__mdrFake
        const base = { by: 'Claude', kind: 'replace', deletedText: 'x', insertedText: 'y', hunkCount: 1, placed: false }
        fake.bridge.setSuggestionSummaries(new Map([[a, { ...base, id: a, unplaced: 'SCHEMA' }], [b, { ...base, id: b, unplaced: 'BASE_NOT_FOUND' }]]))
        fake.bridge.emitLayout('decorations')
      },
      [a, b] as const,
    )
    const schemaRow = ed.testid('suggestionItem', { 'data-suggestion': a })
    await expect(schemaRow).toContainText('Shown as a diff')
    await expect(page.locator(`.mdr-card--rail ${sel('suggestionItem', { 'data-suggestion': a })}`)).toHaveCount(1)
    const section = ed.testid('unplacedSection')
    await expect(section).toContainText('Can’t place inline (1)')
    await section.locator(sel('card', { 'data-thread': more[0]!.thread! })).click()
    await expect(section.locator(sel('suggestionItem', { 'data-suggestion': b }))).toContainText('Can’t place this inline')
    await expect(section.locator(sel('accept'))).toBeEnabled()
  })

  test('Detached with its quote, and back in the rail when the text returns (rows 37, 38)', async ({ page, server, cli }) => {
    // A quote with no near-twin within two blocks: the server's fuzzy step (§5.3 step 5, comments only) would move a
    // comment on `marker16x` to `marker15x` or `marker17x` next door instead of detaching it, which is right for the
    // server and not what this case is about. Paragraph 16 carries none of the seeded threads.
    await seed(cli, [{ op: 'replace_block', target: { quote: 'marker16x' }, markdown: 'Paragraph 16 mentions the xylophone clause once.' }])
    const [made] = await seed(cli, [{ op: 'comment', quote: 'xylophone', body: 'Claude on the xylophone clause.' }])
    const t = made!.thread!
    const ed = await open(page, server.port)
    await expect(cardOf(ed, t)).toHaveAttribute('data-placed', 'true')
    await seed(cli, [{ op: 'replace_block', target: { quote: 'xylophone' }, markdown: 'This paragraph was rewritten without the clause.' }])
    const section = ed.testid('detachedSection')
    await expect(section).toContainText('Detached (1)')
    await section.locator('.mdr-fold-button').click()
    await expect(section.locator(sel('card', { 'data-thread': t })).locator('.mdr-card-quote')).toHaveText('xylophone')
    await seed(cli, [{ op: 'replace_block', target: { quote: 'This paragraph was rewritten without the clause.' }, markdown: 'Paragraph 16 is back and mentions the xylophone clause again.' }])
    await expect(ed.testid('detachedSection')).toHaveCount(0)
    await expect(page.locator(`.mdr-card--rail${sel('card', { 'data-thread': t })}`)).toHaveAttribute('data-placed', 'true')
  })

  test('TJ deletes the highlighted text, then undoes: Detached, then back in the rail (rows 37, 38, real editor)', async ({ page, server, webClient }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'the fake editor takes no keystrokes; the CLI case above moves the card on the fakes')
    const ed = await open(page, server.port)
    const t = ids[1]!.thread!
    await expect(cardOf(ed, t)).toHaveAttribute('data-placed', 'true')
    // the whole highlighted span (row 37): the save after the delete records thread.detach { by: 'TJ' }
    await selectText(page, { from: 'marker12x' })
    await page.keyboard.press('Backspace')
    await expect(ed.testid('detachedSection')).toContainText('Detached (1)', { timeout: 10_000 })
    // undo restores the text; the next save's re-resolution reattaches it (row 38)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(ed.testid('detachedSection')).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator(`.mdr-card--rail${sel('card', { 'data-thread': t })}`)).toHaveAttribute('data-placed', 'true')
    await expect.poll(async () => (await webClient.review()).threads.find((x) => x.id === t)?.anchor ?? null).not.toBeNull()
  })

  test('unread: a Claude reply shows the dot; 1.5 s at ≥ 50% visible clears it; a reload keeps it cleared (§12.9)', async ({ page, server, cli }) => {
    const ed = await open(page, server.port)
    const t = ids[0]!.thread!
    const card = cardOf(ed, t)
    // the seeded comments start unread; the visible one clears after the dwell
    await expect(card.locator(sel('unread'))).toHaveCount(0, { timeout: CONSTANTS.READ_MARK_DWELL_MS + 4000 })
    await seed(cli, [{ op: 'reply', thread: t, body: 'One more thing.' }])
    await expect(card.locator(sel('unread'))).toHaveAttribute('data-count', '1')
    await expect(ed.testid('railHeader').locator(sel('unread'))).toBeVisible()
    // the session sends one marker per thread per READ_MARK_THROTTLE_MS (§12.9): this second one goes when the
    // window that the first marker opened ends
    await expect(card.locator(sel('unread'))).toHaveCount(0, { timeout: CONSTANTS.READ_MARK_THROTTLE_MS + CONSTANTS.READ_MARK_DWELL_MS + 4000 })
    await page.reload()
    await openEditor(page, { port: server.port, file: FILE })
    await railSettled(page)
    await expect(cardOf(ed, t)).toBeVisible()
    await expect(cardOf(ed, t).locator(sel('unread'))).toHaveCount(0)
  })
})

test.describe('p3-threads: unplaced suggestions on the real editor (§6.3, row 72)', () => {
  const DOC = ['# Schema cases', '', 'Intro paragraph.', '', '```js', 'const a = 1', '```', '', 'Outro paragraph stays plain.', ''].join('\n')
  test.beforeEach(async ({ tmpRoot, server }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'the fake editor scripts these summaries (the case above)')
    void server
    tmpRoot.write(FILE, DOC)
  })

  test('a code-block suggestion is "Shown as a diff" at its block and accepts through the server (SCHEMA)', async ({ page, server, cli, tmpRoot }) => {
    const [r] = await seed(cli, [{ op: 'suggest', quote: 'const a = 1', replace: 'const a = 2' }])
    const ed = await open(page, server.port)
    const row = ed.testid('suggestionItem', { 'data-suggestion': r!.suggestion! })
    await expect(row).toContainText('Shown as a diff')
    await expect(page.locator(`.mdr-card--rail ${sel('suggestionItem', { 'data-suggestion': r!.suggestion! })}`)).toHaveCount(1)
    await expect(ed.testid('unplacedSection')).toHaveCount(0)
    await row.locator(sel('accept')).click()
    await expect.poll(() => tmpRoot.read(FILE)).toContain('const a = 2')
  })

  test('a suggestion on a paragraph TJ changed and hasn’t saved yet lists under "Can’t place inline" (BASE_NOT_FOUND)', async ({ page, server, cli }) => {
    const ed = await open(page, server.port)
    // TJ's edit stays in the tab: every save is refused for now
    await page.route(/\/api\/save(\?|$)/, (route) => route.abort())
    await selectText(page, { from: 'stays plain.', collapseAt: 'end' })
    await page.waitForTimeout(300)
    await page.keyboard.type(' TJ is mid-edit.')
    // Claude suggests on the text as saved on disk
    const [r] = await seed(cli, [{ op: 'suggest', quote: 'Outro paragraph stays plain.', replace: 'Outro paragraph, plainly.' }])
    const section = ed.testid('unplacedSection')
    await expect(section).toContainText('Can’t place inline (1)')
    await section.locator(sel('card')).first().click()
    await expect(section.locator(sel('suggestionItem', { 'data-suggestion': r!.suggestion! }))).toContainText('Can’t place this inline')
  })
})

test.describe('p3-threads: a click in the editor keeps its caret (real editor)', () => {
  // A highlight click activates its card, and a click in the text deactivates the active one. Both used to update the
  // editor's active highlight before ProseMirror had read the click's caret, which wrote its previous selection back
  // over the click: on a fresh page that is a node selection on the frontmatter, so the next keystroke replaced the
  // frontmatter on disk. TJ pauses before typing here: a keystroke that beats the click's selectionchange is a
  // separate race inside P2's editor (its initial selection is that node selection), reported to P2.
  const FRONT = '---\ntitle: Click check\nstatus: Draft\n---\n\n'
  test.beforeEach(async ({ tmpRoot, cli, server }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'the fake editor takes no keystrokes')
    void server
    tmpRoot.write(FILE, FRONT + railDoc(12))
    await seed(cli, [{ op: 'comment', quote: 'marker4x', body: 'On four.' }])
  })

  test('a highlight click, then typing: the text lands in the highlight, the frontmatter stays', async ({ page, server, tmpRoot }) => {
    const ed = await open(page, server.port)
    await ed.testid('highlight').first().click()
    await expect(page.locator(`${sel('card')}[data-active="true"]`)).toHaveCount(1)
    await page.waitForTimeout(300)
    await page.keyboard.type('Q')
    await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toContain('Q')
    const md = tmpRoot.read(FILE)
    expect(md.startsWith(FRONT)).toBe(true)
    expect(md).toMatch(/m[a-z]*Q[a-z]*4x|marker4Qx|marker4xQ/)
  })

  test('a card active, a click in another paragraph, then typing: the text lands where clicked', async ({ page, server, tmpRoot }) => {
    const ed = await open(page, server.port)
    await ed.testid('card').first().locator('.mdr-card-body').click()
    await expect(page.locator(`${sel('card')}[data-active="true"]`)).toHaveCount(1)
    await page.getByText('Paragraph 6 talks').click({ position: { x: 4, y: 6 } })
    await expect(page.locator(`${sel('card')}[data-active="true"]`)).toHaveCount(0)
    await page.waitForTimeout(300)
    await page.keyboard.type('Z')
    await expect.poll(() => tmpRoot.read(FILE), { timeout: 10_000 }).toContain('Z')
    const md = tmpRoot.read(FILE)
    expect(md.startsWith(FRONT)).toBe(true)
    expect(md.split('\n').find((l) => l.includes('Z'))).toMatch(/Paragraph 6 talks|^.{0,3}Z.{0,3}aragraph 6/)
  })
})

test.describe('p3-threads: rail header (§11.4, §9.9.1)', () => {
  test.beforeEach(async ({ tmpRoot, cli, server }) => {
    void server
    tmpRoot.write(FILE, railDoc(12))
    await seed(cli, [
      { op: 'suggest', quote: 'about the member and why it matters for marker1x', replace: 'about the stated member and why it matters for marker1x' },
      { op: 'suggest', quote: 'about the tranche and why it matters for marker2x', replace: 'about the senior tranche and why it matters for marker2x' },
    ])
  })

  test('Reject all from Claude is one bulk request; the bulk row goes away when nothing is pending', async ({ page, server, webClient }) => {
    const ed = await open(page, server.port)
    await expect(ed.testid('acceptAllClaude')).toHaveAttribute('aria-disabled', 'false')
    await expect(ed.testid('acceptAllClaude')).toContainText('(2)')
    await ed.testid('rejectAllClaude').click()
    await expect(ed.testid('acceptAllClaude')).toHaveCount(0)
    await expect(ed.testid('rejectAllClaude')).toHaveCount(0)
    expect((await webClient.review()).suggestions.every((s) => s.status === 'rejected')).toBe(true)
  })

  test('"Claude may edit directly" follows and sets the policy', async ({ page, server, webClient }) => {
    await webClient.setPolicy({ suggestOnly: true })
    const ed = await open(page, server.port)
    await openRailSettings(page)
    const sw = ed.testid('policyToggle')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    expect((await webClient.review()).policy.suggestOnly).toBe(false)
  })
})
