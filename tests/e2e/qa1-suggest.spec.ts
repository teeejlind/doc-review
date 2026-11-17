// tests/e2e/qa1-suggest.spec.ts (QA round 1 fixes: QA_FINDINGS seed 2, 3, 4 and confirmed 12, 15, 24, 26).
//
// Claude's suggestions on the real stack: word-level track changes in the doc, the whole phrase on the card, an accepted
// suggestion's thread closing (resolved, not "detached"), and Accept never moving the doc under the cursor.
import { TESTID } from '../../shared/constants'
import { openEditor } from '../helpers/openEditor'
import { claude } from './fixtures/p2'
import { openRailSettings } from './fixtures/p3'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: ['basic.md'], viewport: { width: 1440, height: 900 } })

async function marks(page: import('@playwright/test').Page): Promise<{ del: string[]; ins: string[] }> {
  return page.evaluate(() => ({
    del: Array.from(document.querySelectorAll('.mdr-sugg--del')).map((e) => e.textContent ?? ''),
    ins: Array.from(document.querySelectorAll('.mdr-sugg--ins')).map((e) => e.textContent ?? ''),
  }))
}

test.describe('qa1: word-level suggestions', () => {
  test('12% → 11.5% marks the whole figure, and the card quotes it', async ({ page, editorPage: ed, server }) => {
    await claude(server, 'basic.md', [{ op: 'suggest', quote: '12%', replace: '11.5%', reason: 'Updated rate.' }])
    await expect(page.locator('.mdr-sugg--ins').first()).toBeVisible()
    expect(await marks(page)).toEqual({ del: ['12%'], ins: ['11.5%'] })
    const quote = page.locator(`[data-testid="${TESTID.card}"] .mdr-card-quote`).first()
    await expect(quote).toHaveText(/12%/)
    void ed
  })

  test('a rewrite shows whole words and the card names the whole changed phrase', async ({ page, editorPage: ed, server }) => {
    void ed
    await claude(server, 'basic.md', [{ op: 'suggest', quote: 'Ship the explainer page', replace: 'Launch the lead-gen explainer microsite', reason: 'Name it.' }])
    await expect(page.locator('.mdr-sugg--ins').first()).toBeVisible()
    const m = await marks(page)
    expect(m.del).toEqual(['Ship', 'page'])
    expect(m.ins).toEqual(['Launch', 'lead-gen ', 'microsite'])
    await expect(page.locator(`[data-testid="${TESTID.card}"] .mdr-card-quote`).first()).toHaveText(/Ship the explainer page/)
  })
})

test.describe('qa1: deciding a suggestion', () => {
  test('accepting closes the thread: resolved, not detached, nothing left in the rail', async ({ page, editorPage: ed, server }) => {
    const r = await claude(server, 'basic.md', [{ op: 'suggest', quote: 'paid monthly', replace: 'paid weekly', reason: 'Weekly is the plan.' }])
    const id = r.results[0]!.suggestion!
    const thread = r.results[0]!.thread!
    await expect(page.locator('.mdr-sugg--ins').first()).toBeVisible()
    expect(await ed.bridge((b, sid) => b.accept(sid), id)).toMatchObject({ ok: true })
    await ed.session((s) => s.flush())
    await expect.poll(() => ed.session((s, sid) => s.getReview().suggestions.find((x) => x.id === sid)?.status, id)).toBe('accepted')
    const state = () =>
      ed.session((s, t) => {
        const th = s.getReview().threads.find((x) => x.id === t)!
        return { closed: th.status === 'resolved' || th.autoResolved, detached: th.detached }
      }, thread)
    await expect.poll(state).toEqual({ closed: true, detached: false })
    // closed: no card in the rail, no Detached section entry
    await expect(page.locator(`[data-testid="${TESTID.card}"][data-thread="${thread}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-testid="${TESTID.detachedSection}"]`)).toHaveCount(0)
  })

  for (const w of [1440, 800, 600]) {
    test(`${w} px: Accept clicked on the card closes the thread and the doc does not scroll`, async ({ page, server, tmpRoot }) => {
      await page.setViewportSize({ width: w, height: 800 })
      const long = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i} keeps the document tall enough to scroll in this viewport.`).join('\n\n')
      tmpRoot.write('long.md', `# Long\n\n${long}\n\nThe fee is 1.5% per year.\n\n${long}\n`)
      const ed = await openEditor(page, { port: server.port, file: 'long.md' })
      const r = await claude(server, 'long.md', [{ op: 'suggest', quote: 'The fee is 1.5% per year.', replace: 'The fee is 1.25% per year.', reason: 'Lower fee.' }])
      const thread = r.results[0]!.thread!
      // the caret is up in the first paragraph while TJ scrolled down to the change
      await page.locator('#mdr-editor-host p').first().click()
      const ins = page.locator('.mdr-sugg--ins').first()
      await ins.scrollIntoViewIfNeeded()
      await expect(ins).toBeVisible()
      if (w < 640) await page.locator(`[data-testid="${TESTID.sheetToggle}"]`).click()
      const card = page.locator(`[data-testid="${TESTID.card}"][data-thread="${thread}"]`)
      await expect(card).toBeVisible()
      const scrollOf = () => page.evaluate(() => document.getElementById('mdr-scroll')!.scrollTop)
      const accept = card.locator(`[data-testid="${TESTID.accept}"]`).first()
      if (!(await accept.isVisible())) {
        await card.click({ position: { x: 20, y: 12 } })
        await expect(accept).toBeVisible()
        await page.waitForTimeout(400)
      }
      // (a sheet card that unfolds may bring its change into view above the sheet; Accept itself must not scroll)
      const scrollBefore = await scrollOf()
      await accept.click()
      await page.waitForTimeout(1200)
      await expect(page.locator('.mdr-sugg--ins')).toHaveCount(0)
      await page.waitForTimeout(500)
      expect(Math.abs((await scrollOf()) - scrollBefore)).toBeLessThanOrEqual(1)
      const state = await ed.session((s, t) => {
        const th = s.getReview().threads.find((x) => x.id === t)!
        return { closed: th.status === 'resolved' || th.autoResolved, detached: th.detached }
      }, thread)
      expect(state).toEqual({ closed: true, detached: false })
    })
  }

  test('a thread with a reply still closes when its suggestion is accepted', async ({ page, editorPage: ed, server }) => {
    const r = await claude(server, 'basic.md', [{ op: 'suggest', quote: 'paid monthly', replace: 'paid weekly', reason: 'Weekly is the plan.' }])
    const id = r.results[0]!.suggestion!
    const thread = r.results[0]!.thread!
    await expect(page.locator('.mdr-sugg--ins').first()).toBeVisible()
    await ed.session((s, t) => s.reply(t, 'Why weekly?'), thread)
    expect(await ed.bridge((b, sid) => b.accept(sid), id)).toMatchObject({ ok: true })
    await expect
      .poll(() =>
        ed.session((s, t) => {
          const th = s.getReview().threads.find((x) => x.id === t)!
          return { closed: th.status === 'resolved' || th.autoResolved, detached: th.detached }
        }, thread),
      )
      .toEqual({ closed: true, detached: false })
    void page
  })
})

test.describe('qa1: comments survive edits at their edges', () => {
  const SENTENCE = 'Distributions are intended monthly after a two-year lock.'

  test('accepting a suggestion that replaces the tail of the commented sentence keeps the comment attached', async ({ page, editorPage: ed, server, tmpRoot }) => {
    tmpRoot.write('para.md', `# Fund\n\n${SENTENCE} Redemptions follow the offering documents.\n`)
    const ed2 = await openEditor(page, { port: server.port, file: 'para.md' })
    const c = await claude(server, 'para.md', [
      { op: 'comment', quote: SENTENCE, body: 'Is this still right?' },
      { op: 'suggest', quote: 'two-year lock', replace: '24-month lock', reason: 'Fix.' },
    ])
    const comment = c.results[0]!.thread!
    const sugg = c.results[1]!.suggestion!
    await expect(page.locator('.mdr-sugg--ins').first()).toBeVisible()
    expect(await ed2.bridge((b, id) => b.accept(id), sugg)).toMatchObject({ ok: true })
    await expect.poll(() => tmpRoot.read('para.md')).toContain('24-month lock')
    await expect
      .poll(() => ed2.session((s, t) => s.getReview().threads.find((x) => x.id === t)?.detached, comment))
      .toBe(false)
    await expect(page.locator(`[data-testid="${TESTID.highlight}"][data-thread="${comment}"]`).first()).toBeVisible()
    void ed
  })

  test('Claude rewrites the last word on disk: the comment stays on the surviving text', async ({ page, editorPage: ed, server, tmpRoot }) => {
    tmpRoot.write('para.md', `# Fund\n\n${SENTENCE} Redemptions follow the offering documents.\n`)
    const ed2 = await openEditor(page, { port: server.port, file: 'para.md' })
    const c = await claude(server, 'para.md', [{ op: 'comment', quote: SENTENCE, body: 'Is this still right?' }])
    const comment = c.results[0]!.thread!
    await expect(page.locator(`[data-testid="${TESTID.highlight}"][data-thread="${comment}"]`).first()).toBeVisible()
    tmpRoot.write('para.md', tmpRoot.read('para.md').replace('two-year lock.', 'two-year hold.'))
    await expect.poll(() => ed2.debug.liveMarkdown()).toContain('two-year hold')
    await expect
      .poll(() => ed2.session((s, t) => s.getReview().threads.find((x) => x.id === t)?.detached, comment))
      .toBe(false)
    await expect(page.locator(`[data-testid="${TESTID.highlight}"][data-thread="${comment}"]`).first()).toBeVisible()
    void ed
  })
})

test.describe('qa1: suggestions and their cards activate each other (R2.5)', () => {
  test('clicking the tracked change activates its card; an active card marks its change', async ({ page, editorPage: ed, server }) => {
    const r = await claude(server, 'basic.md', [
      { op: 'suggest', quote: 'paid monthly', replace: 'paid weekly', reason: 'One.' },
      { op: 'suggest', quote: 'Publish the FAQ', replace: 'Publish the long FAQ', reason: 'Two.' },
    ])
    const [t1, t2] = r.results.map((x) => x.thread!)
    const [s1, s2] = r.results.map((x) => x.suggestion!)
    await expect(page.locator('.mdr-sugg--ins')).toHaveCount(2)
    const card = (t: string) => page.locator(`[data-testid="${TESTID.card}"][data-thread="${t}"]`)
    // text → card, on the inserted text and on the struck text
    await page.locator(`.mdr-sugg--ins[data-suggestion="${s2}"]`).first().click()
    await expect(card(t2!)).toHaveAttribute('data-active', 'true')
    await expect(page.locator(`.mdr-sugg[data-suggestion="${s2}"][data-active="true"]`).first()).toBeVisible()
    await expect(page.locator(`.mdr-sugg[data-suggestion="${s1}"][data-active="true"]`)).toHaveCount(0)
    await page.locator(`.mdr-sugg--del[data-suggestion="${s1}"]`).first().click()
    await expect(card(t1!)).toHaveAttribute('data-active', 'true')
    await expect(page.locator(`.mdr-sugg[data-suggestion="${s1}"][data-active="true"]`).first()).toBeVisible()
    await expect(page.locator(`.mdr-sugg[data-suggestion="${s2}"][data-active="true"]`)).toHaveCount(0)
    // card → text
    await card(t2!).locator('.mdr-card-head').click()
    await expect(page.locator(`.mdr-sugg[data-suggestion="${s2}"][data-active="true"]`).first()).toBeVisible()
    await expect(page.locator(`.mdr-sugg[data-suggestion="${s1}"][data-active="true"]`)).toHaveCount(0)
    void ed
  })
})


test.describe('qa1: decided suggestions stay findable under Show resolved (unverified 3)', () => {
  for (const decision of ['accept', 'reject'] as const) {
    test(`a ${decision}ed suggestion's card shows, placed, when Show resolved is on`, async ({ page, editorPage: ed, server }) => {
      const r = await claude(server, 'basic.md', [{ op: 'suggest', quote: 'paid monthly', replace: 'paid weekly', reason: 'Weekly is the plan.' }])
      const id = r.results[0]!.suggestion!
      const thread = r.results[0]!.thread!
      await expect(page.locator('.mdr-sugg--ins').first()).toBeVisible()
      expect(await ed.bridge((b, a) => (a.d === "accept" ? b.accept(a.id) : b.reject(a.id)), { id, d: decision })).toMatchObject({ ok: true })
      const card = page.locator(`[data-testid="${TESTID.card}"][data-thread="${thread}"]`)
      await expect(card).toHaveCount(0) // closed: hidden by default
      await openRailSettings(page)
      await page.locator(`[data-testid="${TESTID.showResolved}"]`).click()
      await expect(card).toBeVisible()
      await expect(card).toContainText(decision === 'accept' ? 'Accepted' : 'Rejected')
      await expect(card).toHaveAttribute('data-placed', 'true')
    })
  }
})
