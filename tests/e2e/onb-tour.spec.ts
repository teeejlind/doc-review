// tests/e2e/onb-tour.spec.ts (onboarding, 2026-11-16): the 2-minute tour inside the real tool.
//
// `mdr tour` (the built CLI) copies the practice doc into the served folder, posts its six cards as Claude and opens
// it. In the page: six cards, in document order, the two suggestions with Accept / Reject, the pill in Suggesting (so
// the "switch to Editing" card makes sense), and the first two steps work: Accept lands the fix in the file, Reject
// leaves the file alone. Then Claude's after-Send round as the skill prescribes it ("When to reply"): nothing here
// needs a reply, so every card is resolved silently and one doc-level note is left; the margin is quiet and Show
// resolved keeps the cards reachable. A second `mdr tour` makes a fresh copy and never touches the used one.
import { TESTID } from '../../shared/constants'
import { TOUR_FILE, TOUR_MD } from '../../node/tour'
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })
test.skip(!BROWSER.available, BROWSER.reason)

test('onb: mdr tour seeds six cards on the practice doc, and Accept / Reject work on it', async ({ page, server, tmpRoot, cli }) => {
  const r = await cli.run(['tour', '--dir', tmpRoot.root])
  expect(r.code, r.stderr).toBe(0)
  const out = r.json as { file: string; url: string; tour: { cards: number; threads: Array<`t_${string}`> }; port: number }
  expect(out).toMatchObject({ file: TOUR_FILE, port: server.port, tour: { cards: 6 } })
  expect(out.tour.threads).toHaveLength(6)
  expect(tmpRoot.read(TOUR_FILE)).toBe(TOUR_MD)

  const ed = await openEditor(page, { port: server.port, file: TOUR_FILE, mode: 'as-loaded' })
  await expect(ed.testid('modePill')).toHaveAttribute('data-mode', 'suggesting')
  const cards = page.locator(`[data-testid="${TESTID.card}"]`)
  await expect(cards).toHaveCount(6)
  // the cards read in document order: the last one asks for Send to Claude
  await expect(cards.last()).toContainText('click Send to Claude')
  await expect(cards.nth(2)).toContainText('reply box')
  await expect(cards.nth(3)).toContainText('Editing')
  await expect(page.getByRole('button', { name: /^Accept: / })).toHaveCount(2)
  await expect(page.getByRole('button', { name: /^Reject: / })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Send to Claude' })).toBeVisible()

  // step 1: accept the typo fix → the file says "morning"
  await page.getByRole('button', { name: /^Accept: / }).first().click()
  await expect.poll(() => tmpRoot.read(TOUR_FILE), { timeout: 10_000 }).toContain('Tuesday morning for coffee')
  // step 2: reject the bad idea → Gerald stays
  await page.getByRole('button', { name: /^Reject: / }).first().click()
  await expect(page.getByRole('button', { name: /^Reject: / })).toHaveCount(0)
  await page.waitForTimeout(1_000)
  expect(tmpRoot.read(TOUR_FILE)).toContain('called Gerald.')

  // Claude's round after Send: they accepted the fix and rejected the bad idea, so nothing teaches; resolve every card
  // with no body and leave one doc-level note
  const round = await cli.batch(TOUR_FILE, {
    ops: [
      ...out.tour.threads.map((thread) => ({ op: 'resolve' as const, thread })),
      { op: 'comment' as const, doc: true, body: "Nice work: that's the whole loop." },
    ],
  })
  expect(round.code, round.stderr).toBe(0)
  const st = await cli.run(['status', cli.abs(TOUR_FILE)])
  expect((st.json as { threads: { open: number; resolved: number } }).threads).toMatchObject({ open: 1, resolved: 6 })
  // the six anchored cards leave the margin; the note is the one thing to read
  await expect(page.locator(`[data-testid="${TESTID.card}"]`).filter({ hasText: 'click Send to Claude' })).toHaveCount(0)
  const onDoc = page.getByRole('button', { name: /^On the document \(1\)/ })
  await expect(onDoc).toBeVisible()
  await onDoc.click()
  await expect(page.getByRole('paragraph').filter({ hasText: "Nice work: that's the whole loop." })).toBeVisible()

  // "show me the tour again": a fresh copy; the used one keeps what the user did
  const again = await cli.run(['tour', '--dir', tmpRoot.root])
  expect(again.code, again.stderr).toBe(0)
  expect((again.json as { file: string }).file).toBe('Welcome to doc-review 2.md')
  expect(tmpRoot.read(TOUR_FILE)).toContain('Tuesday morning')
  expect(tmpRoot.read('Welcome to doc-review 2.md')).toBe(TOUR_MD)
})
