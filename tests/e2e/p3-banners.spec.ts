// tests/e2e/p3-banners.spec.ts (P3; CONTRACTS §12.14, §12.15 banner / bannerAction / recoveredCard / cardAction,
// §13 rows 22, 26, 28–31, 61, §14 P3 E2E "p3-banners").
//
// The §12.14 safety states in a real browser. What the server can produce on its own is produced for real: deleting
// the file (doc-removed), a corrupt sidecar line (read-only with the threads still listed). The states only P2's
// session derives (a docId change, a fingerprint mismatch, a 409 merge, the tab election) are set through the fake
// session's emit() while P3 runs on the fake P2 modules, which is what §2.5 provides for P3's specs; with the real
// P2 those emitted cases are skipped (P2's safety-states test owns the derivation), and the real build produces what it
// can for real instead: a second tab (tab-not-leader, Take over, and precedence under a real delete) and a snapshot
// whose schema fingerprint is rewritten in flight (contract-mismatch, Reload). Recreate checks the session call on the
// fake (its recreate() is local) and the file written back with `cause: 'recreate'` on the real server; deleting the
// sidecar (row 29) runs on the real build only.
import type { Page } from '@playwright/test'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'
import { externalWrite, holdSaves, placeCaret } from './fixtures/p2'
import { fakeEmit, P3_SERVER_KIND, sel, selectText } from './fixtures/p3'

const FILE = 'banners.md'
test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: FILE })

const DOC = '# Banner check\n\nThe first paragraph has a comment on it.\n\nThe second paragraph does not.\n'
const fakeOnly = (): void => test.skip(P3_SERVER_KIND !== 'fake', 'driven through the fake session (P2 derives this state with the real session)')

async function open(page: Page, port: number) {
  await page.setViewportSize({ width: 1440, height: 900 })
  return openEditor(page, { port, file: FILE })
}

test.describe('p3-banners (§12.14)', () => {
  test.beforeEach(async ({ tmpRoot }) => {
    tmpRoot.write(FILE, DOC)
  })

  test('the file is deleted: doc-removed banner; Recreate from my copy writes it back with only the edited block changed (row 28)', async ({ page, server, tmpRoot }) => {
    await open(page, server.port)
    const edited = DOC.replace('does not.', 'does not. Typed just before the delete.')
    if (P3_SERVER_KIND === 'real') {
      // TJ's last edit is still inside the autosave debounce (AUTOSAVE_DEBOUNCE_MS) when the file goes: that save is
      // answered 410 DOC_GONE (or paused by the doc-removed event), so the edit lives only in this tab, and Recreate
      // writes it back (row 28: ops from planSave). The editor is read-only once the banner is up (P2 treats DOC_GONE
      // as a read-only reason), so the edit is made before the delete, not after.
      await selectText(page, { from: 'does not.', collapseAt: 'end' })
      await page.keyboard.type(' Typed just before the delete.')
    }
    tmpRoot.remove(FILE)
    const banner = page.locator(sel('banner', { 'data-kind': 'doc-removed' }))
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText('This file was moved or deleted. Your copy is safe in this tab.')
    await expect(banner).toHaveAttribute('role', 'alert')
    await expect(page.locator(sel('saveChip'))).toHaveAttribute('data-state', 'readonly')
    if (P3_SERVER_KIND === 'real') expect(tmpRoot.exists(FILE)).toBe(false)
    await banner.locator(sel('bannerAction', { 'data-action': 'recreate' })).click()
    await expect(page.locator(sel('banner'))).toHaveCount(0)
    await expect(page.locator(sel('saveChip'))).not.toHaveAttribute('data-state', 'readonly')
    if (P3_SERVER_KIND === 'fake') {
      // the fake session's recreate() is local: what P3 owns is that the action calls it
      const calls = await page.evaluate(() => (window as unknown as { __mdrFake: { session: { calls: Array<{ method: string }> } } }).__mdrFake.session.calls.map((c) => c.method))
      expect(calls).toContain('recreate')
    } else {
      await expect.poll(() => (tmpRoot.exists(FILE) ? tmpRoot.read(FILE) : null), { timeout: 10_000 }).toBe(edited)
      const revs = (tmpRoot.readSidecar(FILE) as Array<{ type: string; by?: string; cause?: string }>).filter((e) => e.type === 'doc.rev')
      expect(revs.at(-1)).toMatchObject({ by: 'TJ', cause: 'recreate' })
    }
  })

  test('the sidecar is deleted: the next write starts a new review and the reset banner shows (row 29)', async ({ page, server, cli, tmpRoot }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'the fake session never derives review-reset from a docId change (the emitted case below covers the UI)')
    let r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'has a comment', body: 'Before the reset.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    await open(page, server.port)
    await expect(page.locator(sel('card')).filter({ hasText: 'Before the reset.' })).toHaveCount(1)
    tmpRoot.remove(`${FILE}.review.jsonl`)
    // the next write creates a new header with a new docId (§13 row 29)
    r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'does not', body: 'After the reset.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    const banner = page.locator(sel('banner', { 'data-kind': 'review-reset' }))
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText('Review data for this file was reset.')
    await expect(page.locator(sel('card')).filter({ hasText: 'Before the reset.' })).toHaveCount(0)
    await expect(page.locator(sel('card')).filter({ hasText: 'After the reset.' })).toHaveCount(1)
    await banner.locator(sel('bannerAction', { 'data-action': 'dismiss' })).click()
    await expect(page.locator(sel('banner'))).toHaveCount(0)
  })

  test('a corrupt sidecar line: read-only, "Ask Claude to run mdr doctor", threads still listed', async ({ page, server, cli, tmpRoot }) => {
    let r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'has a comment', body: 'Still here after the damage.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    r = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'does not', body: 'After the damaged line.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    // a damaged line in the middle (a damaged LAST line is a torn tail, which recovery truncates instead, §4.6)
    const lines = tmpRoot.read(`${FILE}.review.jsonl`).trimEnd().split('\n')
    lines.splice(lines.length - 1, 0, '{"seq": not json')
    tmpRoot.write(`${FILE}.review.jsonl`, lines.join('\n') + '\n')
    await server.restart()
    await open(page, server.port)
    const banner = page.locator(sel('banner', { 'data-kind': 'read-only' }))
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Ask Claude to run mdr doctor')
    await expect(page.locator(sel('card')).filter({ hasText: 'Still here after the damage.' })).toHaveCount(1)
  })

  test('review data reset: dismissible banner', async ({ page, server }) => {
    fakeOnly()
    await open(page, server.port)
    await fakeEmit(page, { banner: { kind: 'review-reset', previousDocId: 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R4', docId: 'd_01JAB3K9Q2T7V5X8Y0Z1W2E3R5' } })
    const banner = page.locator(sel('banner', { 'data-kind': 'review-reset' }))
    await expect(banner).toContainText('Review data for this file was reset.')
    await banner.locator(sel('bannerAction', { 'data-action': 'dismiss' })).click()
    await expect(page.locator(sel('banner'))).toHaveCount(0)
  })

  test('contract mismatch: "This page is out of date." with Reload', async ({ page, server }) => {
    fakeOnly()
    await open(page, server.port)
    await fakeEmit(page, { banner: { kind: 'contract-mismatch', expected: 'aaaa', actual: 'bbbb' } })
    const banner = page.locator(sel('banner', { 'data-kind': 'contract-mismatch' }))
    await expect(banner).toContainText('This page is out of date.')
    await expect(banner.locator(sel('bannerAction', { 'data-action': 'reload' }))).toBeVisible()
    await banner.locator(sel('bannerAction', { 'data-action': 'reload' })).click()
    const calls = await page.evaluate(() => (window as unknown as { __mdrFake: { session: { calls: Array<{ method: string }> } } }).__mdrFake.session.calls.map((c) => c.method))
    expect(calls).toContain('reload')
  })

  test('another tab is editing: "open in another tab, so this tab is read-only" with Take over', async ({ page, server }) => {
    fakeOnly()
    await open(page, server.port)
    await fakeEmit(page, { banner: { kind: 'tab-not-leader' } })
    const banner = page.locator(sel('banner', { 'data-kind': 'tab-not-leader' }))
    await expect(banner).toContainText('open in another tab, so this tab is read-only')
    await banner.locator(sel('bannerAction', { 'data-action': 'take-over' })).click()
    await expect(page.locator(sel('banner'))).toHaveCount(0)
  })

  test('a 409 merge: the recovered-draft card, Keep mine', async ({ page, server }) => {
    fakeOnly()
    await open(page, server.port)
    await fakeEmit(page, { recovered: { reason: 'merge-failed', markdown: '# My copy\n', baseRev: 1, savedAt: new Date().toISOString() } })
    const card = page.locator(sel('recoveredCard', { 'data-kind': 'merge-failed' }))
    await expect(card).toContainText('Couldn’t merge: your copy is kept')
    await expect(card.locator(sel('cardAction'))).toHaveCount(3)
    await card.locator(sel('cardAction', { 'data-action': 'keep-mine' })).click()
    await expect(page.locator(sel('recoveredCard'))).toHaveCount(0)
  })

  // Integrator, P3 merge: the real-server counterpart of the emitted case above, through P3's cards only. TJ's save is
  // held while the disk changes his paragraph (conflict card); his Keep mine (a strict save) is held while the disk
  // changes it again, so the server refuses it whole (409) and P2's session keeps his copy (recovered card).
  test('a 409 merge (real): Keep mine on the conflict card meets a second write; the recovered card keeps my copy', async ({ page, server, tmpRoot }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'the fake session never merges (the emitted case above covers the UI)')
    const ed = await open(page, server.port)
    const gate = await holdSaves(page)
    await placeCaret(page, 'has a comment on it.', 'end')
    await page.keyboard.type(' Mine.')
    await placeCaret(page, 'does not.', 'end')
    await page.keyboard.type(' Elsewhere.')
    await expect.poll(() => gate.held(), { timeout: 10_000 }).toBeGreaterThan(0)
    await externalWrite(server, tmpRoot, FILE, tmpRoot.read(FILE).replace('has a comment on it.', 'has a comment on it, theirs.'))
    await gate.release()
    const conflict = page.locator(sel('conflictCard'))
    await expect(conflict).toHaveCount(1, { timeout: 10_000 })

    const gate2 = await holdSaves(page)
    await conflict.locator(sel('cardAction', { 'data-action': 'keep-mine' })).click()
    await expect.poll(() => gate2.held(), { timeout: 10_000 }).toBeGreaterThan(0)
    await externalWrite(server, tmpRoot, FILE, tmpRoot.read(FILE).replace('has a comment on it, theirs.', 'has a comment on it, theirs again.'))
    await gate2.release()

    const card = page.locator(sel('recoveredCard', { 'data-kind': 'merge-failed' }))
    await expect(card).toContainText('Couldn’t merge: your copy is kept', { timeout: 10_000 })
    await expect(card.locator(sel('cardAction'))).toHaveCount(3)
    expect(tmpRoot.read(FILE)).not.toContain('Mine.')
    await card.locator(sel('cardAction', { 'data-action': 'keep-mine' })).click()
    await expect(page.locator(sel('recoveredCard'))).toHaveCount(0)
    await ed.session((s) => s.flush())
    await expect.poll(() => tmpRoot.read(FILE)).toContain('has a comment on it. Mine.')
    expect(tmpRoot.read(FILE)).toContain('does not. Elsewhere.')
  })

  test('another tab opens the doc (real): it says it is read-only and why; Take over moves the banner to the first tab', async ({ page, context, server }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'the fake session has no tab election (the emitted case above covers the UI)')
    await open(page, server.port)
    const other = await context.newPage()
    await other.setViewportSize({ width: 1440, height: 900 })
    await openEditor(other, { port: server.port, file: FILE })
    const theirs = other.locator(sel('banner', { 'data-kind': 'tab-not-leader' }))
    await expect(theirs).toContainText('open in another tab, so this tab is read-only')
    await expect(other.locator(sel('saveChip'))).toHaveAttribute('data-state', 'readonly')
    // QA3: the read-only tab looks read-only (mode pill and formatting disabled) and a click says why
    await expect(other.locator(sel('modePill'))).toHaveAttribute('aria-disabled', 'true')
    await other.locator('#mdr-editor-host .ProseMirror p').first().click()
    await expect(other.getByText('This tab is read-only because the document is open in another tab.')).toBeVisible()
    await expect(page.locator(sel('banner'))).toHaveCount(0)
    await theirs.locator(sel('bannerAction', { 'data-action': 'take-over' })).click()
    await expect(other.locator(sel('banner'))).toHaveCount(0)
    await expect(page.locator(sel('banner', { 'data-kind': 'tab-not-leader' }))).toBeVisible()
    await expect(page.locator(sel('saveChip'))).toHaveAttribute('data-state', 'readonly')
  })

  test('precedence (real): the file deleted while another tab holds the doc shows doc-removed only', async ({ page, context, server, tmpRoot }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'driven by real tabs and a real delete')
    await open(page, server.port)
    const other = await context.newPage()
    await other.setViewportSize({ width: 1440, height: 900 })
    await openEditor(other, { port: server.port, file: FILE })
    await expect(other.locator(sel('banner', { 'data-kind': 'tab-not-leader' }))).toBeVisible()
    tmpRoot.remove(FILE)
    await expect(other.locator(sel('banner', { 'data-kind': 'doc-removed' }))).toBeVisible({ timeout: 15_000 })
    await expect(other.locator(sel('banner'))).toHaveCount(1)
  })

  test('contract mismatch (real): a snapshot with another schema fingerprint shows "This page is out of date."; Reload loads a matching page', async ({ page, server }) => {
    test.skip(P3_SERVER_KIND === 'fake', 'the fake session never compares fingerprints (the emitted case above covers the UI)')
    // §12.14: snapshot.schemaFingerprint ≠ the bundle's core/md fingerprint. The real server's snapshot is rewritten in
    // flight for the first load only.
    let bump = true
    await page.route(/\/api\/doc\?/, async (route) => {
      const res = await route.fetch()
      const body = (await res.json()) as { schemaFingerprint?: string }
      if (bump && typeof body.schemaFingerprint === 'string') body.schemaFingerprint = body.schemaFingerprint.replace(/^./, (c) => (c === 'f' ? 'e' : 'f'))
      await route.fulfill({ response: res, json: body })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await openEditor(page, { port: server.port, file: FILE, wait: 'editor' })
    const banner = page.locator(sel('banner', { 'data-kind': 'contract-mismatch' }))
    await expect(banner).toContainText('This page is out of date.')
    await expect(page.locator(sel('saveChip'))).toHaveAttribute('data-state', 'readonly')
    bump = false
    await banner.locator(sel('bannerAction', { 'data-action': 'reload' })).click()
    await page.waitForLoadState('load')
    await expect(page.locator(sel('editor'))).toBeVisible()
    await expect(page.locator(sel('banner'))).toHaveCount(0)
    await expect(page.locator(sel('saveChip'))).not.toHaveAttribute('data-state', 'readonly')
  })

  test('precedence: only the highest banner shows', async ({ page, server }) => {
    fakeOnly()
    await open(page, server.port)
    await fakeEmit(page, { banner: { kind: 'contract-mismatch', expected: 'a', actual: 'b' } })
    await expect(page.locator(sel('banner'))).toHaveCount(1)
    await expect(page.locator(sel('banner'))).toHaveAttribute('data-kind', 'contract-mismatch')
  })
})
