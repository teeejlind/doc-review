// tests/e2e/p2-autosave.spec.ts (P2; CONTRACTS §14 P2 e2e "p2-autosave", §7.1, §12.4, §12.5, §12.0.5, §13 #1, #62, #77,
// D43). Real typing in Chromium: the server dies mid-typing → getSaveState() 'offline' → 'saved' once it is back
// (retrySave); a reload while the edits exist only in IndexedDB loses nothing; closing the tab sends the keepalive save
// and the /api/flush beacon; a page opened at http://localhost:<port>/ saves with origin-relative requests (row 77); a
// save that landed but whose response was lost is retried with the identical saveId and adopted as 'duplicate' (§12.4).
// The save chip's labels are P3's.
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { LINE_END, placeCaret, saveState } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: ['basic.md'] })
test.skip(!BROWSER.available, BROWSER.reason)

test('p2-autosave: server killed mid-typing → offline; back → saved through retrySave(); nothing lost', async ({ page, editorPage: ed, server, tmpRoot }) => {
  await page.getByText('We launch in Q3.').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' Before.')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Before.')
  await expect.poll(() => saveState(ed)).toBe('saved')

  await server.stop()
  await page.keyboard.type(' During the outage.')
  await expect.poll(() => saveState(ed), { timeout: 15_000 }).toBe('offline')
  const offline = await ed.session((s) => s.getSaveState())
  expect(offline).toMatchObject({ state: 'offline' })
  expect(tmpRoot.read('basic.md')).not.toContain('During the outage.')
  // more typing while offline is kept too
  await page.keyboard.type(' Still typing.')

  await server.restart()
  await ed.session((s) => s.retrySave())
  await expect.poll(() => saveState(ed), { timeout: 15_000 }).toBe('saved')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Before. During the outage. Still typing.')
  expect(await ed.debug.planSave()).toEqual([])
})

test('p2-autosave: a reload while the edits exist only in the IndexedDB draft loses nothing (§12.5)', async ({ page, editorPage: ed, server, tmpRoot }) => {
  const original = tmpRoot.read('basic.md')
  await server.stop()
  await page.getByText('Final paragraph').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' Draft only.')
  await expect.poll(() => saveState(ed), { timeout: 15_000 }).toBe('offline')
  await page.waitForTimeout(600) // the draft write is debounced (DRAFT_DEBOUNCE_MS) and runs in an idle callback

  // refuse every save and beacon until the reloaded page has fetched the doc, so only the IndexedDB draft survives
  let block = true
  const writes: string[] = []
  await page.route(/\/api\/(save|flush)(\?|$)/, async (route) => {
    writes.push(`${block ? 'refused' : 'sent'} ${new URL(route.request().url()).pathname}`)
    if (block) await route.abort()
    else await route.continue()
  })
  page.on('request', (r) => {
    if (r.method() === 'GET' && /^\/api\/(doc|review|events)$/.test(new URL(r.url()).pathname)) block = false
  })
  await server.restart()
  expect(tmpRoot.read('basic.md')).toBe(original)

  await page.reload()
  const ed2 = await openEditor(page, { port: server.port, file: 'basic.md' })
  await expect.poll(() => ed2.debug.liveMarkdown(), { timeout: 15_000 }).toContain('`code`. Draft only.')
  await expect.poll(() => tmpRoot.read('basic.md'), { timeout: 15_000 }).toBe(original.replace('`code`.', '`code`. Draft only.'))
  await expect.poll(() => saveState(ed2)).toBe('saved')
  // the old page's saves (backoff retry, pagehide keepalive) were refused; the reloaded page's draft save went through
  expect(writes.some((w) => w.startsWith('refused /api/save'))).toBe(true)
  expect(writes.some((w) => w.startsWith('sent /api/save'))).toBe(true)
})

test('p2-autosave: closing the tab flushes: keepalive save, then the /api/flush beacon (§7.1, §13 #62)', async ({ page, editorPage: _ed, tmpRoot }) => {
  const context = page.context()
  const seen: string[] = []
  context.on('request', (r) => {
    if (r.method() === 'POST') seen.push(new URL(r.url()).pathname)
  })
  await page.getByText('The member rate is reviewed every quarter.').click()
  await page.keyboard.press(LINE_END)
  // close well inside the 600 ms debounce: only the pagehide path can save this
  await page.keyboard.type(' Closing now.', { delay: 0 })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => tmpRoot.read('basic.md'), { timeout: 10_000 }).toContain('reviewed every quarter. Closing now.')
  await expect.poll(() => seen).toEqual(expect.arrayContaining(['/api/save', '/api/flush']))
  expect(seen.indexOf('/api/save')).toBeLessThan(seen.lastIndexOf('/api/flush'))
  // the beacon closed TJ's coalesced edit session: its doc.edit is in the sidecar
  await expect.poll(() => (tmpRoot.readSidecar('basic.md') as Array<{ type?: string }>).some((e) => e.type === 'doc.edit'), { timeout: 10_000 }).toBe(true)
})

test('p2-autosave: a page opened at http://localhost:<port>/ saves; every request stays same-origin (row 77, D43)', async ({ page, server, tmpRoot }) => {
  const hosts = new Set<string>()
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/')) hosts.add(u.host)
  })
  const ed = await openEditor(page, { port: server.port, file: 'basic.md', host: 'localhost' })
  await page.getByText('Publish the FAQ').click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' today')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('- Publish the FAQ today')
  await expect.poll(() => saveState(ed)).toBe('saved')
  expect([...hosts]).toEqual([`localhost:${server.port}`])
})

test('p2-autosave: a save that landed but lost its response is re-sent with the same saveId and adopted as a duplicate (§12.4)', async ({ page, editorPage: ed, tmpRoot }) => {
  const sent: Array<{ saveId: number; clientId: string }> = []
  const applied: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/save(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search)) {
      const b = r.postDataJSON() as { saveId: number; clientId: string }
      sent.push({ saveId: b.saveId, clientId: b.clientId })
    }
  })
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/save' && r.ok()) {
      applied.push(((await r.json()) as { applied: string }).applied)
    }
  })
  // the first save reaches the server (route.fetch) but the page only sees a network failure
  let dropped = false
  await page.route(/\/api\/save(\?|$)/, async (route) => {
    if (dropped) return route.continue()
    dropped = true
    await route.fetch()
    await route.abort('failed')
  })
  await placeCaret(page, 'We launch in Q3.', 'end')
  await page.keyboard.type(' Exactly once.')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Exactly once.')
  await expect.poll(() => saveState(ed), { timeout: 15_000 }).toBe('offline')
  // the backoff retry re-sends the identical request; the server recognises it
  await expect.poll(() => saveState(ed), { timeout: 15_000 }).toBe('saved')
  expect(sent.length).toBeGreaterThanOrEqual(2)
  expect(sent[1]).toEqual(sent[0])
  expect(applied).toContain('duplicate')
  const disk = tmpRoot.read('basic.md')
  expect(disk.split('Exactly once.').length).toBe(2)
  expect(await ed.debug.planSave()).toEqual([])
  // and the session keeps saving from the adopted base
  await page.keyboard.type(' Then more.')
  await expect.poll(() => tmpRoot.read('basic.md')).toContain('We launch in Q3. Exactly once. Then more.')
  expect(tmpRoot.read('basic.md').split('Exactly once.').length).toBe(2)
})
