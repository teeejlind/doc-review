// tests/e2e/p3-history.spec.ts (P3; CONTRACTS §10 UI, §12.15 history*, §13 row 64, §14 P3 E2E "p3-history").
//
// Version history in a real browser: open the panel from the top bar, pick from / to (`mdr-history-pick`), read the
// author-coloured diff, restore a version; the panel closes once the restore has resolved, and the editor then shows
// the restored text (with the real P2 after the P2 merge; the fake editor re-renders from the restore response
// before). The versions come from two Claude writes through the CLI.
import type { Page } from '@playwright/test'
import { openEditor } from '../helpers/openEditor'
import { expect, test, type CliHelper } from './fixtures'
import { P3_SERVER_KIND, sel } from './fixtures/p3'

const FILE = 'history.md'
test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: FILE })

const V1 = '# History check\n\nThe launch is planned for Q3.\n\nA paragraph that never changes.\n\nThe owner is Jordan.\n'
const V2 = V1.replace('planned for Q3', 'planned for Q4')
const V3 = V2.replace('The owner is Jordan.', 'The owner is TJ.') + '\nA closing line Claude added.\n'

async function write(cli: CliHelper, markdown: string, baseRev: number): Promise<number> {
  const r = await cli.batch(FILE, { ops: [{ op: 'write', markdown, baseRev }] })
  expect(r.ok, r.stdout + r.stderr).toBe(true)
  return (JSON.parse(r.stdout) as { rev: number }).rev
}

async function open(page: Page, port: number) {
  await page.setViewportSize({ width: 1440, height: 900 })
  const ed = await openEditor(page, { port, file: FILE })
  await page.locator(sel('historyButton')).click()
  const panel = page.locator(sel('historyPanel'))
  await expect(panel).toBeVisible()
  return { ed, panel }
}

test.describe('p3-history', () => {
  test.beforeEach(async ({ tmpRoot, cli, webClient }) => {
    tmpRoot.write(FILE, V1)
    const rev0 = (await webClient.doc()).rev
    const rev1 = await write(cli, V2, rev0)
    await write(cli, V3, rev1)
  })

  test('timeline, from/to picks and an author-coloured diff', async ({ page, server }) => {
    const { panel } = await open(page, server.port)
    const rows = panel.locator(sel('historyVersion'))
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3)
    await expect(rows.first()).toHaveAttribute('data-v', 'current')
    await expect(panel.locator(`${sel('historyVersion')}[data-by="Claude"]`).first()).toBeVisible()
    // pick the oldest version as "from" and the current text as "to"
    const versions = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.v!))
    const oldest = versions.at(-1)!
    await panel.locator(sel('historyPick', { 'data-v': oldest, 'data-role': 'from' })).click()
    await panel.locator(sel('historyPick', { 'data-v': 'current', 'data-role': 'to' })).click()
    await expect(panel.locator(sel('historyPick', { 'data-v': oldest, 'data-role': 'from' }))).toHaveAttribute('aria-pressed', 'true')
    const diff = panel.locator(sel('historyDiff'))
    await expect(diff).toContainText(`From ${oldest} to the current version`)
    // Q3 → Q4 as a word diff, struck and underlined; Claude's colour on both changed blocks
    await expect(diff.locator('.mdr-hd-block[data-op="replace"] del').first()).toContainText('Q3')
    await expect(diff.locator('.mdr-hd-block[data-op="replace"] ins').first()).toContainText('Q4')
    // the added line is inserted text (its own insert block, or the tail of a 1 → 2 block replace)
    await expect(diff.locator('.mdr-hd-block ins', { hasText: 'A closing line Claude added.' })).toHaveCount(1)
    for (const b of await diff.locator('.mdr-hd-block:not([data-op="equal"])').all()) await expect(b).toHaveAttribute('data-by', 'Claude')
    const ins = diff.locator('.mdr-hd-block ins').first()
    expect(await ins.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('underline')
    expect(await diff.locator('.mdr-hd-block[data-op="replace"] del').first().evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('line-through')
  })

  test('restore: the panel closes once restored, the editor shows the restored text, the file has it', async ({ page, server, tmpRoot }) => {
    const { ed, panel } = await open(page, server.port)
    const rows = panel.locator(sel('historyVersion'))
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3)
    // the version whose text is V2 (Q4, Jordan): the second Claude write's predecessor
    const target = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.v!).filter((v) => v !== 'current'))
    let v2: string | null = null
    for (const v of target) {
      const text = await ed.session((s, ver) => s.history.show(ver as `v${number}`).then((x) => x.markdown), v)
      if (text.includes('planned for Q4') && text.includes('Jordan')) v2 = v
    }
    expect(v2, 'a version holding V2').not.toBeNull()
    await panel.locator(sel('historyRestore', { 'data-v': v2! })).click()
    await expect(panel).toHaveCount(0)
    // focus goes back to the History button
    await expect(page.locator(sel('historyButton'))).toBeFocused()
    await expect(ed.editor()).toContainText('The owner is Jordan.')
    await expect(ed.editor()).not.toContainText('A closing line Claude added.')
    await expect.poll(() => tmpRoot.read(FILE)).toBe(V2)
  })

  test('Esc closes the panel', async ({ page, server }) => {
    const { panel } = await open(page, server.port)
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })
})
