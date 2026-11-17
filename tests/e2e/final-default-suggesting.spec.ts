// tests/e2e/final-default-suggesting.spec.ts (TJ, 2026-11-16: "when I open up a doc, it defaults to 'suggest' mode
// instead of edit"). Every open starts in Suggesting: the pill, the editor and the rail hint say so, and typing is a
// tracked suggestion that leaves the file alone. Switching to Editing still works for the session, and is not
// remembered: a reload, or an old per-doc memory from before this change, opens in Suggesting again.
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { placeCaret, summaries } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })
test.skip(!BROWSER.available, BROWSER.reason)

const DOC = '# Plan\n\nWe launch in Q3 with three partners.\n'

test('final: a doc opens in Suggesting, and a reload after switching to Editing opens in Suggesting again', async ({ page, server, tmpRoot }) => {
  tmpRoot.write('d.md', DOC)
  let ed = await openEditor(page, { port: server.port, file: 'd.md', mode: 'as-loaded' })
  const pill = ed.testid('modePill')
  await expect(pill).toHaveAttribute('data-mode', 'suggesting')
  await expect(ed.editor()).toHaveAttribute('data-mode', 'suggesting')
  expect(await ed.bridge((b) => b.getMode())).toBe('suggesting')
  await expect(page.getByText('Your edits are tracked as suggestions.')).toBeVisible()

  // typing is a tracked suggestion by TJ; the file is untouched
  await placeCaret(page, 'Q3', 'select')
  await page.keyboard.type('Q4', { delay: 20 })
  await expect.poll(async () => (await summaries(ed)).map((s) => `${s.by}:${s.deletedText}>${s.insertedText}`)).toEqual(['TJ:Q3>Q4'])
  await page.waitForTimeout(1_500)
  expect(tmpRoot.read('d.md')).toBe(DOC)

  // switch to Editing for this session: it works
  await pill.click()
  await expect(pill).toHaveAttribute('data-mode', 'editing')
  await expect(pill).toHaveAccessibleName(/^Editing mode/)

  // reload: Suggesting again
  await page.reload()
  ed = await openEditor(page, { port: server.port, file: 'd.md', mode: 'as-loaded' })
  await expect(ed.testid('modePill')).toHaveAttribute('data-mode', 'suggesting')
  expect(await ed.bridge((b) => b.getMode())).toBe('suggesting')

  // a per-doc memory written by an older build (mdr:mode:<rootHash>:<file> = editing) is ignored
  await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('mdr:mode:')) localStorage.setItem(k, 'editing')
    }
    localStorage.setItem('mdr:mode:legacy:d.md', 'editing')
  })
  ed = await openEditor(page, { port: server.port, file: 'd.md', mode: 'as-loaded' })
  await expect(ed.testid('modePill')).toHaveAttribute('data-mode', 'suggesting')
})
