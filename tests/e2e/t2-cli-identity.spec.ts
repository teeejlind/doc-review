// tests/e2e/t2-cli-identity.spec.ts (fix pass T2 cli; QA_FINDINGS Pass 4 #13). The real built server, the real CLI and the
// real page, with the name coming from config.json (no MDR_USER_NAME): after `mdr config set name "<name>"` the open page
// kept showing the old name on its cards (and in the prompt it copies) until it was reloaded, while `mdr status`, Claude and
// the wake prompt already used the new one. The page now asks GET /api/me again when the person returns to it and when
// Claude does something, and swaps the name in place.
import type { Page } from '@playwright/test'
import type { ConfigResult, ThreadId } from '../../shared/types'
import { pageWaiter, tid, toastOf } from '../helpers/int'
import { openEditor } from '../helpers/openEditor'
import { expect, test, type CliHelper } from './fixtures'
import { clipWrites, installClipboard } from './fixtures/p3'
import { ok } from './fixtures/p4'

const FILE = 'identity.md'
const DOC = '# Identity\n\nThe member rate is reviewed every quarter.\n\nA second paragraph for company.\n'
// the e2e fixtures pin MDR_USER_NAME=TJ; empty means "not set", so config.json decides
const NO_ENV_NAME = { MDR_USER_NAME: '' }

test.use({ serverKind: 'real', fixtureFiles: [], docFile: FILE, serverEnv: NO_ENV_NAME })

const setName = async (cli: CliHelper, name: string): Promise<void> => {
  const r = ok<ConfigResult>(await cli.run(['config', 'set', 'name', name], { env: NO_ENV_NAME }))
  expect(r.user).toEqual({ displayName: name, source: 'config' })
}
/** The reviewer's own reply on a thread: its author label is the display name. */
const myReplyAuthor = (page: Page, thread: string) =>
  page.locator(tid('card', { 'data-thread': thread })).locator(tid('message', { 'data-by': 'TJ' })).locator('.mdr-message-author')
/** Claude's comment on a quote; returns its thread id. */
async function claudeComments(cli: CliHelper, quote: string, body: string): Promise<string> {
  const r = ok<{ results: Array<{ thread: string }> }>(await cli.batch(FILE, { ops: [{ op: 'comment', quote, body }] }))
  return r.results[0]!.thread
}
const metaName = (page: Page): Promise<string | null> => page.locator('meta[name="mdr-user-name"]').getAttribute('content')

test('the open page picks up a new name when the person comes back to it, with no reload', async ({ page, cli, server, tmpRoot, webClient }) => {
  tmpRoot.write(FILE, DOC)
  await installClipboard(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await setName(cli, 'Ana Díaz')
  const thread = await claudeComments(cli, 'A second paragraph for company.', 'Which company?')
  await openEditor(page, { port: server.port, file: FILE })
  await expect.poll(() => pageWaiter(page)).toBe('none')
  await webClient.reply(thread as ThreadId, 'The one in the title.')
  await expect(myReplyAuthor(page, thread)).toHaveText('Ana Díaz')

  // the skill's "offer once": Claude sets the name; the page is open and not reloaded
  await setName(cli, 'Marisol Vega')
  expect(await metaName(page)).toBe('Ana Díaz')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(myReplyAuthor(page, thread)).toHaveText('Marisol Vega')
  expect(await metaName(page)).toBe('Marisol Vega')

  // the prompt the page copies for Claude names the new person too
  await page.locator(tid('send')).click()
  await expect(toastOf(page, 'HANDOFF_COPIED')).toBeVisible()
  const writes = await clipWrites(page)
  expect(writes).toHaveLength(1)
  expect(writes[0]!.split('\n')[0]).toMatch(/^\[doc-review\] Marisol Vega sent `identity\.md` back to you/)
  // storage is unchanged: the actor id stays TJ
  expect(tmpRoot.read(`${FILE}.review.jsonl`)).toContain('"by":"TJ"')
  expect(tmpRoot.read(`${FILE}.review.jsonl`)).not.toContain('Marisol')
})

test('or when Claude does something next: a comment in the margin is enough, the page was never refocused', async ({ page, cli, server, tmpRoot, webClient }) => {
  test.setTimeout(60_000)
  tmpRoot.write(FILE, DOC)
  await page.setViewportSize({ width: 1440, height: 900 })
  await setName(cli, 'Ana Díaz')
  const thread = await claudeComments(cli, 'A second paragraph for company.', 'Which company?')
  await openEditor(page, { port: server.port, file: FILE })
  await webClient.reply(thread as ThreadId, 'The one in the title.')
  await expect(myReplyAuthor(page, thread)).toHaveText('Ana Díaz')

  await setName(cli, 'Marisol Vega')
  await claudeComments(cli, 'The member rate is reviewed every quarter.', 'Quarterly or monthly?')
  await expect(myReplyAuthor(page, thread)).toHaveText('Marisol Vega', { timeout: 20_000 })
  await expect(page.locator(tid('card', { 'data-thread': thread })).locator(tid('message', { 'data-by': 'TJ' }))).toHaveCount(1)
})

test('a focus on a name that did not change costs one GET /api/me and changes nothing', async ({ page, cli, server, tmpRoot }) => {
  tmpRoot.write(FILE, DOC)
  await setName(cli, 'Ana Díaz')
  await openEditor(page, { port: server.port, file: FILE })
  const asks: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/me') asks.push(r.method())
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => asks.length).toBe(1)
  expect(asks).toEqual(['GET'])
  expect(await metaName(page)).toBe('Ana Díaz')
})
