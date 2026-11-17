// tests/e2e/qa1-editing.spec.ts (QA round 1: confirmed 22).
import { expect, test } from './fixtures'
import { selectText } from './fixtures/p3'

test.use({ serverKind: 'real', docFile: 'basic.md' })

test('strikethrough shows a line through the struck text', async ({ page, editorPage: ed, tmpRoot }) => {
  await selectText(page, { from: 'member' })
  await page.keyboard.press('Meta+Shift+x')
  await ed.settled()
  const deco = await page.evaluate(() => {
    const el = document.querySelector('#mdr-editor-host .ProseMirror del:not(.mdr-sugg--del)')
    return el ? getComputedStyle(el).textDecorationLine : null
  })
  expect(deco).toBe('line-through')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('~~')
})

test('retyping a commented phrase keeps the whole new text highlighted (not just its first letter)', async ({ page, editorPage: ed, server }) => {
  const { claude } = await import('./fixtures/p2')
  const r = await claude(server, 'basic.md', [{ op: 'comment', quote: 'member rate of 12%', body: 'Still right?' }])
  const thread = r.results[0]!.thread!
  const hl = page.locator(`#mdr-editor-host .hl[data-thread="${thread}"]`)
  await expect(hl.first()).toBeVisible()
  await selectText(page, { from: 'member rate of 12%' })
  await page.keyboard.type('interest of 9%', { delay: 20 })
  await ed.settled()
  await expect.poll(async () => (await hl.allTextContents()).join('')).toBe('interest of 9%')
  await ed.session((s) => s.flush())
  await expect
    .poll(() => ed.session((s, t) => { const a = s.getReview().threads.find((x) => x.id === t)?.anchor; return a && a.kind === 'text' ? a.quote : null }, thread))
    .toBe('interest of 9%')
  // a caret move elsewhere ends the replacement: typing after the highlight does not extend it
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
  await page.keyboard.type('XYZ')
  expect((await hl.allTextContents()).join('')).toBe('interest of 9%')
})

test.describe('table cell selection (confirmed 13)', () => {
  const DOC = '# Sel\n\n| Name | Rate |\n| --- | --- |\n| Alpha | 12% |\n| Beta | 9% |\n'

  test('dragging across cells shades them and Comment anchors the whole selection', async ({ page, server, tmpRoot }) => {
    tmpRoot.write('sel.md', DOC)
    const { openEditor } = await import('../helpers/openEditor')
    const ed = await openEditor(page, { port: server.port, file: 'sel.md' })
    const alpha = page.locator('#mdr-editor-host td', { hasText: 'Alpha' })
    const rate = page.locator('#mdr-editor-host td', { hasText: '12%' })
    const a = (await alpha.boundingBox())!
    const b = (await rate.boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 })
    await page.mouse.up()
    const shades = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mdr-editor-host .selectedCell')).map((c) => getComputedStyle(c).backgroundColor),
    )
    expect(shades).toHaveLength(2)
    for (const bg of shades) expect(bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent', `cell paints ${bg}`).toBe(false)
    await page.keyboard.press('Meta+Alt+m')
    const quote = page.locator('[data-testid="mdr-card"][data-draft="true"] .mdr-card-quote')
    await expect(quote).toContainText('Alpha')
    await expect(quote).toContainText('12%')
    void ed
  })
})

test('the table control bar never covers the text above the table (confirmed 31)', async ({ page, server, tmpRoot }) => {
  tmpRoot.write('tbl.md', '# T\n\nThe line right above the table.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n')
  const { openEditor } = await import('../helpers/openEditor')
  await openEditor(page, { port: server.port, file: 'tbl.md' })
  await page.locator('#mdr-editor-host td').first().click()
  const bar = page.locator('[data-testid="mdr-table-controls"]')
  await expect(bar).toBeVisible()
  const gap = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('#mdr-editor-host p')).find((x) => x.textContent?.includes('right above the table'))!
    const r = document.createRange()
    r.selectNodeContents(p)
    const textBottom = r.getBoundingClientRect().bottom
    const barTop = document.querySelector('[data-testid="mdr-table-controls"]')!.getBoundingClientRect().top
    return barTop - textBottom
  })
  expect(gap).toBeGreaterThanOrEqual(0)
})

test('the text being commented on keeps a visible highlight while the new-comment box is open (confirmed 6, second half)', async ({ page, editorPage: ed }) => {
  await selectText(page, { from: 'member rate of 12%' })
  await page.keyboard.press('Meta+Alt+m')
  const hl = page.locator('#mdr-editor-host [data-draft-highlight]')
  await expect(page.locator('[data-testid="mdr-card"][data-draft="true"] textarea')).toBeFocused()
  await expect.poll(async () => (await hl.allTextContents()).join('')).toBe('member rate of 12%')
  // cancelling the draft takes the highlight with it
  await page.keyboard.press('Escape')
  await expect(hl).toHaveCount(0)
  void ed
})
