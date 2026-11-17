// tests/e2e/qa4-editor-lists.spec.ts (QA round 4, editor fixer): Pass 4 #6 to #9 and #24 on the real keyboard.
// The bar: in Suggesting mode, Accept writes the Markdown the same keystrokes write in Editing mode.
import type { Page } from '@playwright/test'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'
import type { EditorPage } from '../helpers/openEditor'

test.use({ serverKind: 'real', fixtureFiles: [] })

const LIST = '# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n'
const STEPS = '1. First step\n2. Second step\n3. Third step\n4. Fourth step\n'
const PARA = '# T\n\nFirst sentence is here. Second sentence follows it. Third one ends.\n\nTail.\n'

type Keys = (page: Page) => Promise<void>

async function run(page: Page, ctx: { port: number; tmpRoot: Parameters<typeof openDoc>[1]['tmpRoot'] }, file: string, md: string, mode: 'editing' | 'suggesting', keys: Keys): Promise<string> {
  const ed: EditorPage = await openDoc(page, { port: ctx.port, tmpRoot: ctx.tmpRoot, file, content: md })
  if (mode === 'suggesting') await ed.testid('modePill').click()
  await keys(page)
  await page.waitForTimeout(1_200)
  if (mode === 'suggesting') {
    await expect.poll(() => ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').length), { timeout: 15_000 }).toBeGreaterThan(0)
    const ids = await ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').map((x) => x.id))
    for (const id of ids) expect(await ed.bridge((b, sid) => b.accept(sid), id)).toMatchObject({ ok: true })
  }
  return savedText(ed, ctx.tmpRoot, file)
}

const both = async (page: Page, ctx: Parameters<typeof run>[1], n: string, md: string, keys: Keys): Promise<{ edit: string; sugg: string }> => ({
  edit: await run(page, ctx, `${n}-e.md`, md, 'editing', keys),
  sugg: await run(page, ctx, `${n}-s.md`, md, 'suggesting', keys),
})

const bs = async (page: Page, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(250)
  }
}

test('#6: lifting a bullet out and joining it (Backspace twice at its start) accepts to what Editing writes', async ({ page, server, tmpRoot }) => {
  const r = await both(page, { port: server.port, tmpRoot }, 'p6', LIST, async (p) => {
    await placeCaret(p, 'Gamma item', 'start')
    await bs(p, 2)
  })
  expect(r.edit).toBe('# T\n\n- Alpha item\n- Beta itemGamma item\n\nTail.\n')
  expect(r.sugg).toBe(r.edit)
})

test('#6: the same keys on a quote leave no stray >', async ({ page, server, tmpRoot }) => {
  const r = await both(page, { port: server.port, tmpRoot }, 'p6q', '# T\n\n> Quote one\n\nTail.\n', async (p) => {
    await placeCaret(p, 'Quote one', 'start')
    await bs(p, 2)
  })
  expect(r.sugg).toBe(r.edit)
})

test('#7: Enter just before a space, then typing: the text lands on the new line', async ({ page, server, tmpRoot }) => {
  const r = await both(page, { port: server.port, tmpRoot }, 'p7', PARA, async (p) => {
    await placeCaret(p, 'is here.', 'end')
    await p.keyboard.press('Enter')
    await p.keyboard.type('New paragraph text', { delay: 20 })
  })
  expect(r.edit).toContain('First sentence is here.\n\nNew paragraph text')
  expect(r.sugg).toBe(r.edit)
})

test('#8: Editing, deleting a middle numbered item keeps one list', async ({ page, server, tmpRoot }) => {
  const out = await run(page, { port: server.port, tmpRoot }, 'p8.md', STEPS, 'editing', async (p) => {
    await placeCaret(p, 'Second step', 'select')
    await bs(p, 3)
  })
  expect(out).toBe('1. First step\n2. Third step\n3. Fourth step\n')
})

test('#9 and #24: Suggesting, select an item and Backspace twice: Accept removes the bullet', async ({ page, server, tmpRoot }) => {
  const md = '## Goals\n\n- Grow the waitlist\n- Ship the explainer page\n- Publish the FAQ\n\nTail.\n'
  const sugg = await run(page, { port: server.port, tmpRoot }, 'p9.md', md, 'suggesting', async (p) => {
    await placeCaret(p, 'Ship the explainer page', 'select')
    await bs(p, 2)
  })
  expect(sugg).toBe('## Goals\n\n- Grow the waitlist\n- Publish the FAQ\n\nTail.\n')
})
