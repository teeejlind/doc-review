// tests/e2e/t2-suggest-list-delete.spec.ts (T2 suggest track): Delete at the end of a list item's text on the real
// keyboard. Editing joins the next item's text into this item (Google Docs), and Suggesting's Accept writes the same.
import type { Page } from '@playwright/test'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'
import type { EditorPage } from '../helpers/openEditor'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const LIST = '# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n'

async function run(page: Page, ctx: { port: number; tmpRoot: Parameters<typeof openDoc>[1]['tmpRoot'] }, file: string, md: string, mode: 'editing' | 'suggesting', at: string): Promise<string> {
  const ed: EditorPage = await openDoc(page, { port: ctx.port, tmpRoot: ctx.tmpRoot, file, content: md })
  if (mode === 'suggesting') await ed.testid('modePill').click()
  await placeCaret(page, at, 'end')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(1_200)
  if (mode === 'suggesting') {
    await expect.poll(() => ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').length), { timeout: 15_000 }).toBeGreaterThan(0)
    const ids = await ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').map((x) => x.id))
    for (const id of ids) expect(await ed.bridge((b, sid) => b.accept(sid), id)).toMatchObject({ ok: true })
  }
  return savedText(ed, ctx.tmpRoot, file)
}

test('Delete at the end of a bullet joins the next bullet into it, in Editing and Suggesting alike', async ({ page, server, tmpRoot }) => {
  const ctx = { port: server.port, tmpRoot }
  const edit = await run(page, ctx, 'e.md', LIST, 'editing', 'Alpha item')
  expect(edit).toBe('# T\n\n- Alpha itemBeta item\n- Gamma item\n\nTail.\n')
  const sugg = await run(page, ctx, 's.md', LIST, 'suggesting', 'Alpha item')
  expect(sugg).toBe(edit)
})

test('Delete at the end of the last bullet takes the paragraph after the list into it', async ({ page, server, tmpRoot }) => {
  const ctx = { port: server.port, tmpRoot }
  const edit = await run(page, ctx, 'e2.md', LIST, 'editing', 'Gamma item')
  expect(edit).toBe('# T\n\n- Alpha item\n- Beta item\n- Gamma itemTail.\n')
  expect(await run(page, ctx, 's2.md', LIST, 'suggesting', 'Gamma item')).toBe(edit)
})
