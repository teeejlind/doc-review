// tests/e2e/p2-decisions.spec.ts (P2; CONTRACTS §14 P2 e2e "p2-decisions", §6.3, §6.6, §13 #40, #48, #72, #79, D26,
// D31). Claude's suggestions arrive through the agent route; every decision goes through window.__mdrDebug.bridge()
// (the cards are P3's, §12.0.4) and undo/redo through the real keyboard: accept / reject one and all; accept all in a
// thread is one request and one undo; undo/redo of a single decision and of a bulk; a changed text cancels the whole
// bulk undo; two rapid accepts apply once; a code-block suggestion and a table-row suggest_block are unplaced SCHEMA
// and accept through the server.
import { browserChoice } from '../helpers/browser'
import { captureNotices, claude, MOD, notices, openDoc, pressInEditor, summaries, trackWrites } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: ['basic.md'] })
test.skip(!BROWSER.available, BROWSER.reason)

const BULK = '/api/suggestions/bulk'

test('p2-decisions: accept one, reject one; two rapid accepts send one request and apply once', async ({ page, editorPage: ed, server, tmpRoot }) => {
  const original = tmpRoot.read('basic.md')
  const r = await claude(server, 'basic.md', [
    { op: 'suggest', quote: 'paid monthly', replace: 'paid every month' },
    { op: 'suggest', quote: 'Publish the FAQ', replace: 'Publish the long FAQ' },
  ])
  const [a, b] = r.results.map((x) => x.suggestion!)
  await expect.poll(async () => (await summaries(ed)).filter((s) => s.placed && s.by === 'Claude').length).toBe(2)
  await expect(ed.testid('suggestion', { 'data-suggestion': a! }).first()).toBeVisible()
  const writes = trackWrites(page)

  // double-click protection: two accepts in the same tick → one request, one application
  const results = await ed.bridge((br, id) => Promise.all([br.accept(id), br.accept(id)]), a!)
  expect(results.some((x) => x.ok)).toBe(true)
  expect(writes.count(`/api/suggestions/${a}/accept`)).toBe(1)
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('paid every month')
  expect(tmpRoot.read('basic.md').split('paid every month').length).toBe(2)
  await expect(ed.testid('suggestion', { 'data-suggestion': a! })).toHaveCount(0)
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('paid every month')

  // reject: marks gone, the file keeps its text
  expect(await ed.bridge((br, id) => br.reject(id), b!)).toMatchObject({ ok: true })
  await expect(ed.testid('suggestion', { 'data-suggestion': b! })).toHaveCount(0)
  await ed.session((s) => s.flush())
  expect(tmpRoot.read('basic.md')).toBe(original.replace('paid monthly', 'paid every month'))
  await expect.poll(() => ed.session((s, ids) => ids.map((id) => s.getReview().suggestions.find((x) => x.id === id)?.status), [a!, b!])).toEqual(['accepted', 'rejected'])
  expect(await ed.debug.planSave()).toEqual([])
})

test('p2-decisions: accept all in a thread is one request and one undo; redo replays it', async ({ page, editorPage: ed, server, tmpRoot }) => {
  const original = tmpRoot.read('basic.md')
  const first = await claude(server, 'basic.md', [{ op: 'suggest', quote: 'Grow the waitlist', replace: 'Grow the waitlist fast' }])
  const thread = first.results[0]!.thread!
  await claude(server, 'basic.md', [
    { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q4.', thread },
    { op: 'suggest', quote: 'A short quote', replace: 'A brief quote', thread },
  ])
  // (each in its own block: two records on one block in one bulk depend on the server's §6.7 rebase, P1's)
  // a suggestion outside the thread stays pending through all of this
  const other = (await claude(server, 'basic.md', [{ op: 'suggest', quote: 'Final paragraph', replace: 'Last paragraph' }])).results[0]!.suggestion!
  await expect.poll(async () => (await summaries(ed)).filter((s) => s.placed).length).toBe(4)
  const inThread = await ed.session((s, t) => s.getReview().threads.find((x) => x.id === t)!.suggestions, thread)
  expect(inThread).toHaveLength(3)
  const writes = trackWrites(page)

  const bulk = await ed.bridge((br, ids) => br.acceptAll({ ids }), inThread)
  expect(bulk).not.toBeNull()
  expect(writes.all().filter((p) => p.startsWith('/api/suggestions'))).toEqual([BULK])
  const accepted = original.replace('Grow the waitlist', 'Grow the waitlist fast').replace('We launch in Q3.', 'We launch in Q4.').replace('A short quote', 'A brief quote')
  await expect.poll(() => tmpRoot.read('basic.md')).toBe(accepted)
  await expect.poll(async () => (await summaries(ed)).map((s) => s.id)).toEqual([other])

  // ONE undo reopens all three, as ONE atomic bulk request
  writes.clear()
  await pressInEditor(ed, `${MOD}+KeyZ`)
  await ed.session((s) => s.flush())
  expect(writes.all().filter((p) => p.startsWith('/api/suggestions'))).toEqual([BULK])
  await expect.poll(() => tmpRoot.read('basic.md')).toBe(original)
  await expect.poll(async () => (await summaries(ed)).filter((s) => s.placed).length).toBe(4)
  await expect.poll(() => ed.session((s, ids) => ids.map((id) => s.getReview().suggestions.find((x) => x.id === id)?.status), inThread)).toEqual(['pending', 'pending', 'pending'])

  // redo replays the bulk
  await pressInEditor(ed, `${MOD}+Shift+KeyZ`)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toBe(accepted)
  await expect.poll(async () => (await summaries(ed)).map((s) => s.id)).toEqual([other])
})

test('p2-decisions: undo and redo of a single accept (reopen, then accept again); reject all from Claude', async ({ page, editorPage: ed, server, tmpRoot }) => {
  const original = tmpRoot.read('basic.md')
  const r = await claude(server, 'basic.md', [
    { op: 'suggest', quote: 'reviewed every quarter', replace: 'reviewed every month' },
    { op: 'suggest', quote: 'We launch in Q3.', replace: 'We launch in Q4.' },
  ])
  const [a, b] = r.results.map((x) => x.suggestion!)
  await expect.poll(async () => (await summaries(ed)).length).toBe(2)
  const writes = trackWrites(page)

  expect(await ed.bridge((br, id) => br.accept(id), a!)).toMatchObject({ ok: true })
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('reviewed every month')
  await pressInEditor(ed, `${MOD}+KeyZ`)
  await ed.session((s) => s.flush())
  expect(writes.count(`/api/suggestions/${a}/reopen`)).toBe(1)
  await expect.poll(() => tmpRoot.read('basic.md')).toBe(original)
  await expect(ed.testid('suggestion', { 'data-suggestion': a! }).first()).toBeVisible()
  // the reopen is a queue item, never a save field: no save carried it
  await pressInEditor(ed, `${MOD}+Shift+KeyZ`)
  await ed.session((s) => s.flush())
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('reviewed every month')
  await expect(ed.testid('suggestion', { 'data-suggestion': a! })).toHaveCount(0)

  // reject all from Claude: one bulk request; b's marks go, the file keeps its text
  writes.clear()
  const res = await ed.bridge((br) => br.rejectAll({ by: 'Claude' }))
  expect(res).not.toBeNull()
  expect(writes.all().filter((p) => p.startsWith('/api/suggestions'))).toEqual([BULK])
  await expect(ed.testid('suggestion', { 'data-suggestion': b! })).toHaveCount(0)
  await ed.session((s) => s.flush())
  expect(tmpRoot.read('basic.md')).toBe(original.replace('reviewed every quarter', 'reviewed every month'))
})

test('p2-decisions: undo of a bulk accept after Claude changed one accepted text is cancelled whole (§13 #79)', async ({ editorPage: ed, server, tmpRoot }) => {
  await claude(server, 'basic.md', [
    { op: 'suggest', quote: 'Grow the waitlist', replace: 'Grow the list' },
    { op: 'suggest', quote: 'The member rate is reviewed every quarter.', replace: 'The member rate is reviewed each quarter.' },
  ])
  await expect.poll(async () => (await summaries(ed)).length).toBe(2)
  await captureNotices(ed)
  expect(await ed.bridge((br) => br.acceptAll({ by: 'Claude' }))).not.toBeNull()
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('reviewed each quarter')
  // Claude rewrites one of the accepted blocks; the page reloads it (no history entry)
  await claude(server, 'basic.md', [{ op: 'replace_block', target: { quote: 'reviewed each quarter' }, markdown: 'The member rate is reviewed each quarter, says Claude.' }])
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('says Claude')
  await pressInEditor(ed, `${MOD}+KeyZ`)
  await ed.session((s) => s.flush()).catch(() => undefined)
  await expect.poll(() => notices(ed.page)).toContain('UNDO_CANCELLED')
  // never half-undone: both accepted texts stay, in the editor and on disk, with no marks left
  const disk = tmpRoot.read('basic.md')
  expect(disk).toContain('Grow the list')
  expect(disk).toContain('says Claude')
  await expect.poll(async () => (await summaries(ed)).length).toBe(0)
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('Grow the list')
  expect(await ed.debug.planSave()).toEqual([])
})

test.describe('unplaced', () => {
  test.use({ fixtureFiles: [] })
  const DOC = [
    '# Schema cases',
    '',
    'Intro paragraph.',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '| Name | Rate |',
    '| --- | --- |',
    '| Alpha | 1 |',
    '',
    'Outro paragraph.',
    '',
  ].join('\n')
  const TABLE2 = '| Name | Rate |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |'

  test('p2-decisions: a code-block suggestion and a table-row suggest_block report unplaced SCHEMA and accept through the server (§13 #72)', async ({ page, server, tmpRoot }) => {
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'schema.md', content: DOC })
    const r = await claude(server, 'schema.md', [
      { op: 'suggest', quote: 'const a = 1', replace: 'const a = 2' },
      { op: 'suggest_block', target: { quote: 'Rate' }, markdown: TABLE2 },
    ])
    const [code, table] = r.results.map((x) => x.suggestion!)
    await expect.poll(async () => (await summaries(ed)).length).toBe(2)
    const sum = await summaries(ed)
    expect(sum.find((s) => s.id === code)).toMatchObject({ placed: false, unplaced: 'SCHEMA', by: 'Claude' })
    expect(sum.find((s) => s.id === table)).toMatchObject({ placed: false, unplaced: 'SCHEMA', by: 'Claude' })
    // an unplaced SCHEMA card is anchored at its run's first block
    const rects = await ed.bridge((b, ids) => ids.map((id) => b.getAnchorRects([id]).get(id) ?? null), [code!, table!])
    expect(rects.every((x) => x !== null)).toBe(true)
    // nothing was marked inline
    await expect(ed.testid('suggestion')).toHaveCount(0)

    expect(await ed.bridge((b, id) => b.accept(id), code!)).toMatchObject({ ok: true })
    await expect.poll(() => tmpRoot.read('schema.md')).toContain('const a = 2')
    await expect.poll(() => ed.debug.liveMarkdown()).toContain('const a = 2')
    expect(await ed.bridge((b, id) => b.accept(id), table!)).toMatchObject({ ok: true })
    await expect.poll(() => tmpRoot.read('schema.md')).toBe(DOC.replace('const a = 1', 'const a = 2').replace('| Alpha | 1 |', '| Alpha | 1 |\n| Beta | 2 |'))
    await expect.poll(() => ed.debug.liveMarkdown()).toContain('Beta')
    await expect(page.locator('#mdr-editor-host table tr')).toHaveCount(3)
    expect(await ed.debug.planSave()).toEqual([])
  })
})
