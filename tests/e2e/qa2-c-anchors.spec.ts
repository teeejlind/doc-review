// tests/e2e/qa2-c-anchors.spec.ts (QA round 1, fix pass 2: confirmed 10).
//
// A comment on one repeated cell ('Live' in the third row) stays on that row when Claude adds a same-shaped row above,
// live and after a reload, and the anchor the server persists names the right row.
import { openDoc, placeCaret, externalWrite } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const DOC = '# Deal status\n\n| Deal | Status |\n|---|---|\n| Deal A | Live |\n| Deal B | Live |\n| Deal C | Live |\n\nClosing note.\n'

test('qa2-c: a same-shaped table row added above keeps the comment on its own row, in the page and in the sidecar', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'table-repeat.md', content: DOC })
  await placeCaret(page, 'Live', 'select', 2)
  const target = await ed.bridge((b) => b.getSelectionTarget())
  if (target?.kind !== 'anchor') throw new Error('expected a text anchor')
  const thread = (await ed.session((s, a) => s.createThread(a, 'Is Deal C really live?'), target.anchor)).thread.id
  const hl = ed.testid('highlight', { 'data-thread': thread })
  const rowOfHl = (): Promise<string> => hl.first().evaluate((el) => (el.closest('tr')?.textContent ?? '').replace(/\s+/g, ' ').trim())
  await expect(hl.first()).toBeVisible()
  expect(await rowOfHl()).toBe('Deal CLive')

  // Claude adds a row on top of the table, the same shape as the others
  const disk = tmpRoot.read('table-repeat.md')
  await externalWrite(server, tmpRoot, 'table-repeat.md', disk.replace('| Deal A | Live |', '| Deal Z | Live |\n| Deal A | Live |'))
  await expect.poll(() => ed.debug.liveMarkdown()).toContain('| Deal Z | Live |')
  await expect(hl.first()).toBeVisible()
  await expect.poll(rowOfHl).toBe('Deal CLive')

  // the anchor the server stored for it says Deal C, not Deal B
  await expect
    .poll(() => {
      const log = tmpRoot.readSidecar('table-repeat.md') as Array<{ type?: string; thread?: string; anchor?: { prefix?: string } }>
      const ups = log.filter((e) => e.type === 'anchor.update' && e.thread === thread)
      return ups.length ? ups[ups.length - 1]!.anchor?.prefix?.endsWith('Deal C\n') : null
    })
    .toBe(true)

  // and a reload keeps it there
  await page.reload()
  const ed2 = await (await import('../helpers/openEditor')).openEditor(page, { port: server.port, file: 'table-repeat.md' })
  const hl2 = ed2.testid('highlight', { 'data-thread': thread })
  await expect(hl2.first()).toBeVisible()
  expect(await hl2.first().evaluate((el) => (el.closest('tr')?.textContent ?? '').replace(/\s+/g, ' ').trim())).toBe('Deal CLive')
})
