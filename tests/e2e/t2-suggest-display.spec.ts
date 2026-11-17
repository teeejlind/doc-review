// tests/e2e/t2-suggest-display.spec.ts (T2 suggest track): Pass 4 #22 and the list lift / merge display leftover, in the
// real browser (layout, computed styles, where the card sits). The doc keeps suggest-changes' shape; what the page
// draws leaves out the copy that shows nothing new.
import type { Page } from '@playwright/test'
import { TESTID } from '../../shared/constants'
import { MOD, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: [], viewport: { width: 1440, height: 900 } })

const PARA = '# T\n\nWe will announce new lender programs next quarter, and we will tell every lender about the new lender programs in the second half of the year.\n\nTail.\n'
const LIST = '# T\n\n- Alpha item\n- Beta item\n- Gamma item\n\nTail.\n'

/** The text of every tracked change the page really draws (it has a box), by kind. */
async function drawn(page: Page): Promise<{ del: string[]; ins: string[]; fmt: string[]; mod: string[] }> {
  return page.evaluate(() => {
    const out = { del: [] as string[], ins: [] as string[], fmt: [] as string[], mod: [] as string[] }
    const shown = (e: Element): boolean => e.getClientRects().length > 0 && !e.closest('.mdr-sugg--shadow')
    for (const e of Array.from(document.querySelectorAll<HTMLElement>('#mdr-editor-host .ProseMirror .mdr-sugg'))) {
      if (!shown(e)) continue
      const t = e.textContent ?? ''
      if (e.classList.contains('mdr-sugg--del')) out.del.push(t)
      else if (e.classList.contains('mdr-sugg--ins')) out.ins.push(t)
      else if (e.classList.contains('mdr-sugg--fmt')) out.fmt.push(t)
      else if (e.classList.contains('mdr-sugg--mod')) out.mod.push(t)
    }
    return out
  })
}

const card = `[data-testid="${TESTID.card}"]`

test('Bold: no struck copy on the page, the words are bold and marked, the card quotes just them and sits beside them', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'b.md', content: PARA })
  await ed.testid('modePill').click()
  await placeCaret(page, 'new lender programs', 'select')
  await page.keyboard.press(`${MOD}+b`)
  await expect(page.locator(card)).toHaveCount(1, { timeout: 15_000 })

  expect(await drawn(page)).toEqual({ del: [], ins: [], fmt: ['new lender programs'], mod: [] })
  await expect(page.locator('#mdr-editor-host .ProseMirror [data-kind="del"]')).toBeHidden()
  const weight = await page.locator('#mdr-editor-host .mdr-sugg--fmt').evaluate((e) => Number(getComputedStyle(e).fontWeight))
  expect(weight).toBeGreaterThanOrEqual(600)
  const line = await page.locator('#mdr-editor-host .mdr-sugg--fmt').evaluate((e) => getComputedStyle(e).textDecorationLine)
  expect(line).not.toContain('line-through')

  await expect(page.locator(`${card} .mdr-suggestion-kind`)).toHaveText('Bold: new lender programs')
  await expect(page.locator(`${card} .mdr-card-quote`)).toHaveText('new lender programs')
  // the card sits level with the words, so the hidden copy is not what places it
  const textTop = await page.locator('#mdr-editor-host .mdr-sugg--fmt').evaluate((e) => e.getBoundingClientRect().top)
  const cardTop = await page.locator(card).first().evaluate((e) => e.getBoundingClientRect().top)
  expect(Math.abs(cardTop - textTop)).toBeLessThan(160)

  // Accept writes the bold, as Editing would
  const id = await ed.session((s) => s.getReview().suggestions.find((x) => x.status === 'pending')!.id)
  expect(await ed.bridge((b, sid) => b.accept(sid), id)).toMatchObject({ ok: true })
  expect(await savedText(ed, tmpRoot, 'b.md')).toBe(PARA.replace('new lender programs next', '**new lender programs** next'))
})

test('Heading 2 and a bulleted list: no strike and re-insert, and the card quotes one line', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'h.md', content: PARA })
  await ed.testid('modePill').click()
  await placeCaret(page, 'announce', 'end')
  await page.keyboard.press(`${MOD}+Alt+2`)
  await expect(page.locator(card)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator(`${card} .mdr-suggestion-kind`)).toHaveText('Heading 2')
  const q = (await page.locator(`${card} .mdr-card-quote`).textContent()) ?? ''
  expect(q.length).toBeLessThanOrEqual(90)
  expect(PARA).toContain(q)
  expect((await drawn(page)).del).toEqual([])

  const ed2 = await openDoc(page, { port: server.port, tmpRoot, file: 'l.md', content: PARA })
  await ed2.testid('modePill').click()
  await placeCaret(page, 'announce', 'end')
  await page.locator(`[data-testid="${TESTID.toolbarButton}"][data-action="bullet"]`).click()
  await expect(page.locator(card)).toHaveCount(1, { timeout: 15_000 })
  const seen = await drawn(page)
  expect(seen.del).toEqual([])
  expect(seen.ins).toEqual([])
  expect(seen.mod).toHaveLength(1)
  expect(await page.locator('#mdr-editor-host .ProseMirror').innerText()).not.toMatch(/(We will announce[^]*){2}/)
})

test('lifting the middle bullet out: only the lifted item is marked, the other bullets read as they were', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'lift.md', content: LIST })
  await ed.testid('modePill').click()
  await placeCaret(page, 'Beta item', 'start')
  await page.keyboard.press('Backspace')
  await expect(page.locator(card)).toHaveCount(1, { timeout: 15_000 })
  expect(await drawn(page)).toEqual({ del: [], ins: [], fmt: [], mod: ['Beta item'] })
  const visible = await page.locator('#mdr-editor-host .ProseMirror').innerText()
  expect(visible.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['T', 'Alpha item', 'Beta item', 'Gamma item', 'Tail.'])
  await expect(page.locator(`${card} .mdr-suggestion-kind`)).toHaveText('Lift out of list: Beta item')
  await expect(page.locator(`${card} .mdr-card-quote`)).toHaveText('Beta item')

  // after a reload the suggestion is hydrated from its record, and the page draws the same thing
  await expect.poll(() => ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').length)).toBe(1)
  await page.reload()
  await expect(page.locator(card)).toHaveCount(1, { timeout: 15_000 })
  expect(await drawn(page)).toEqual({ del: [], ins: [], fmt: [], mod: ['Beta item'] })

  // Accept writes what Editing writes, Reject the original bytes
  const id = await ed.session((s) => s.getReview().suggestions.find((x) => x.status === 'pending')!.id)
  expect(await ed.bridge((b, sid) => b.reject(sid), id)).toMatchObject({ ok: true })
  expect(await savedText(ed, tmpRoot, 'lift.md')).toBe(LIST)
})

test('lifting and joining the last bullet: the two items above the join are struck once, the joined one is green once', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'join.md', content: LIST })
  await ed.testid('modePill').click()
  await placeCaret(page, 'Gamma item', 'start')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  await page.keyboard.press('Backspace')
  await expect(page.locator(card)).toHaveCount(1, { timeout: 15_000 })
  const seen = await drawn(page)
  // (the card sits on each struck item's list-level mark, so the struck text comes from its two list items)
  expect(seen.del.join('|')).toBe('Beta item|Gamma item')
  expect(seen.ins).toEqual(['Beta itemGamma item'])
  const text = (await page.locator('#mdr-editor-host .ProseMirror').innerText()).split('\n').map((l) => l.trim()).filter(Boolean)
  expect(text).toEqual(['T', 'Alpha item', 'Beta item', 'Gamma item', 'Beta itemGamma item', 'Tail.'])
})
