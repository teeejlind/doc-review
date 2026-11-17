// tests/e2e/qa4-auth-lost.spec.ts (QA pass 4 #3). The real server restarts under an open tab (new session token). The
// tab must say so in plain words with a Reload button (no raw UNAUTHORIZED / "wrong token"), stop retrying, and Reload
// must bring back what was typed since the last save from the local draft store.
import { rmSync } from 'node:fs'
import { markerPath } from '../../server/marker'
import { browserChoice } from '../helpers/browser'
import { tid } from '../helpers/int'
import { LINE_END, saveState } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: ['basic.md'] })
test.skip(!BROWSER.available, BROWSER.reason)

test('qa4 #3: a restarted server → "lost its connection" banner with Reload, no error codes; Reload keeps the typed text', async ({ page, editorPage: ed, server, tmpRoot }) => {
  await page.getByText('We launch in Q3.').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' Before.')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Before.')
  await expect.poll(() => saveState(ed)).toBe('saved')

  // `mdr stop` + `mdr serve` (or a crash): no marker survives, so the new server mints a new token
  const oldToken = server.token
  await server.stop()
  rmSync(markerPath(server.root), { force: true })
  await server.restart()
  expect(server.token).not.toBe(oldToken)
  await page.keyboard.type(' After restart.')

  const banner = page.locator(tid('banner'))
  await expect(banner).toBeVisible({ timeout: 20_000 })
  await expect(banner).toContainText('This page lost its connection to the review. Reload to keep going.')
  await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/UNAUTHORIZED|wrong token/)
  expect(tmpRoot.read('basic.md')).not.toContain('After restart.')

  await banner.getByRole('button', { name: 'Reload' }).click()
  await expect(page.getByText('We launch in Q3. Before. After restart.')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(tid('banner'))).toHaveCount(0)
  await expect.poll(() => tmpRoot.read('basic.md'), { timeout: 15_000 }).toContain('We launch in Q3. Before. After restart.')
})
