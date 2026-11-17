// tests/e2e/t2-editor-ux-readonly.spec.ts (T2 editor-ux, Pass 4 #23): in a read-only second tab, Cmd+Opt+M with text selected
// comments on the selection, not on the whole document.
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { MOD } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

test('#23: in a read-only second tab, Cmd+Opt+M with text selected comments on the selection', async ({ page, context, server, tmpRoot }) => {
  tmpRoot.write('k.md', 'Change the middle word here.\n')
  await openEditor(page, { port: server.port, file: 'k.md' })
  const other = await context.newPage()
  await other.setViewportSize({ width: 1440, height: 900 })
  await openEditor(other, { port: server.port, file: 'k.md' })
  await expect(other.locator('[data-testid="mdr-banner"][data-kind="tab-not-leader"]')).toBeVisible()
  // select "middle" the way a reader does, then the shortcut
  await other.evaluate(() => {
    const t = document.querySelector('#mdr-editor-host .ProseMirror p')!.firstChild!
    const i = (t.textContent ?? '').indexOf('middle')
    getSelection()!.setBaseAndExtent(t, i, t, i + 'middle'.length)
  })
  await other.waitForTimeout(150)
  expect(await other.evaluate(() => getSelection()!.toString())).toBe('middle')
  await other.keyboard.press(`${MOD}+Alt+KeyM`)
  // the draft card's box, not the dock (whose box is "Comment on the whole document")
  await expect(other.locator('[data-draft="true"] textarea')).toHaveAttribute('aria-label', 'Comment on “middle”')
  await expect(other.locator('[data-draft="true"] .mdr-card-quote')).toHaveText('middle')
})
