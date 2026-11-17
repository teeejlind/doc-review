// tests/e2e/t2-editor-ux-cell.spec.ts (T2 editor-ux, Pass 4 #27): in a table cell the block buttons are disabled and say why.
import { browserChoice } from '../helpers/browser'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

test('#27: in a table cell the block buttons are disabled and say why; outside it they work', async ({ page, server, tmpRoot }) => {
  const md = 'Intro line.\n\n| a | b |\n|---|---|\n| one | two |\n'
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: md })
  const btn = (action: string) => page.locator(`[data-testid="mdr-toolbar-button"][data-action="${action}"]`)
  await page.locator('#mdr-editor-host td', { hasText: 'one' }).click()
  for (const [action, why] of [['bullet', 'list'], ['ordered', 'list'], ['task', 'list'], ['blockquote', 'quote'], ['code-block', 'code block'], ['heading-2', 'heading']] as const) {
    await expect(btn(action)).toHaveAttribute('aria-disabled', 'true')
    await expect(btn(action)).toHaveAttribute('title', `A table cell can't hold a ${why}.`)
  }
  await expect(btn('bold')).not.toHaveAttribute('aria-disabled', 'true')
  await btn('bullet').click({ force: true })
  await btn('code-block').click({ force: true })
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe(md)
  await placeCaret(page, 'Intro', 'end')
  await expect(btn('bullet')).not.toHaveAttribute('aria-disabled', 'true')
  await btn('bullet').click()
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe(md.replace('Intro line.', '- Intro line.'))
})
