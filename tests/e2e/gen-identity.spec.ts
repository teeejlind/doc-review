// tests/e2e/gen-identity.spec.ts (generalization pass). mdr for any user, on the built CLI and the real server:
// - the display name (MDR_USER_NAME) is what the page shows for the human (the new-comment card, their thread card,
//   their reply), GET /api/me, and `user` in `mdr open`; storage keeps the actor id 'TJ';
// - MDR_CMD and the display name reach the copied prompt;
// - `mdr --version`; `mdr open --launch` starts the system browser only while no tab is connected (recorded through
//   MDR_TEST_LAUNCH_LOG); `mdr stop --all` stops a foreground server, whose process then exits 0; the idle exit
//   (MDR_IDLE_EXIT_MIN) ends a foreground server that nothing uses.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CONSTANTS, TESTID } from '../../shared/constants'
import type { MeResult, OpenResult, StopAllResult, VersionResult } from '../../shared/types'
import { MDR_VERSION } from '../../shared/version'
import { openEditor } from '../helpers/openEditor'
import { startServer, workerPort } from '../helpers/startServer'
import { tmpRoot as makeTmpRoot } from '../helpers/tmpRoot'
import { expect, test } from './fixtures'
import { railDoc, railSettled, selectText } from './fixtures/p3'

const FILE = 'threads.md'
const NAME = 'Ana Díaz'
const sel = (key: keyof typeof TESTID, attrs: Record<string, string> = {}): string =>
  `[data-testid="${TESTID[key]}"]` + Object.entries(attrs).map(([k, v]) => `[${k}="${v}"]`).join('')

async function postFocused(page: Page, body: string): Promise<void> {
  await expect(page.locator(`${sel('cardReply')}:focus`)).toHaveCount(1)
  await page.keyboard.type(body)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect
    .poll(() => page.evaluate((id) => (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.testid === id ? document.activeElement.value : ''), TESTID.cardReply))
    .toBe('')
  await railSettled(page, 400)
}

test.describe('the display name, end to end', () => {
  test.use({ fixtureFiles: [], docFile: FILE, serverEnv: { MDR_USER_NAME: NAME, MDR_CMD: 'mdr-test' } })
  test.beforeEach(async ({ tmpRoot }) => {
    tmpRoot.write(FILE, railDoc(12))
  })

  test('the page labels the human by display name; storage keeps the actor id TJ', async ({ page, server, cli, webClient, tmpRoot }) => {
    const seeded = await cli.batch(FILE, { ops: [{ op: 'comment', quote: 'marker2x', body: 'Claude on paragraph 2.' }] })
    expect(seeded.ok, seeded.stdout + seeded.stderr).toBe(true)
    const claudeThread = (JSON.parse(seeded.stdout) as { results: Array<{ thread: string }> }).results[0]!.thread
    await page.setViewportSize({ width: 1440, height: 900 })
    await openEditor(page, { port: server.port, file: FILE })
    await railSettled(page)

    // the new-comment card on a selection
    await selectText(page, { from: 'collateral', collapseAt: 'start' })
    await page.keyboard.press('ControlOrMeta+Alt+KeyM')
    const draft = page.locator(`${sel('card')}[data-draft="true"]`)
    await expect(draft.locator('.mdr-card-author')).toHaveText(NAME)
    await expect(draft.locator('.mdr-card-author')).toHaveAttribute('data-by', 'TJ')
    await postFocused(page, 'A comment from Ana.')
    // their own thread card
    let mine = ''
    await expect.poll(async () => {
      const t = (await webClient.review()).threads.find((x) => x.messages.some((m) => m.body === 'A comment from Ana.'))
      mine = t?.id ?? ''
      return t?.messages[0]?.by
    }).toBe('TJ')
    await expect(page.locator(sel('card', { 'data-thread': mine })).locator('.mdr-card-author')).toHaveText(NAME)
    // a reply on Claude's thread
    const card = page.locator(sel('card', { 'data-thread': claudeThread }))
    await card.locator(sel('cardReply')).click()
    await postFocused(page, 'My reply.')
    const reply = card.locator(sel('message', { 'data-by': 'TJ' }))
    await expect(reply.locator('.mdr-message-author')).toHaveText(NAME)
    await expect(card.locator('.mdr-card-author')).toHaveText('Claude')
    expect(tmpRoot.read(`${FILE}.review.jsonl`)).toContain('"by":"TJ"')
    expect(tmpRoot.read(`${FILE}.review.jsonl`)).not.toContain(NAME)
  })

  test('GET /api/me, `user` in mdr open, and the copied prompt name the user and MDR_CMD', async ({ server, cli, webClient, tmpRoot }) => {
    const me = await fetch(`http://${CONSTANTS.HOST}:${server.port}/api/me`, { headers: { Authorization: `Bearer ${server.token}`, 'X-MDR-Client': 'web' } })
    expect(me.status).toBe(200)
    expect((await me.json()) as MeResult).toEqual({ ok: true, displayName: NAME, source: 'env' })
    const o = await cli.run(['open', cli.abs(FILE)])
    expect(o.ok, o.stdout + o.stderr).toBe(true)
    expect((o.json as OpenResult).user).toEqual({ displayName: NAME, source: 'env' })
    const h = await webClient.handoff(undefined, 'clipboard')
    const [first, second] = h.prompt.split('\n')
    expect(first).toMatch(new RegExp(`^\\[doc-review\\] ${NAME} sent \`${FILE}\` back to you \\(round #1: `))
    expect(second).toBe(`Run: mdr-test pending "${tmpRoot.path(FILE)}" --root "${tmpRoot.root}"`)
  })
})

test.describe('CLI for anyone: --version, --launch, stop --all, idle exit', () => {
  test.use({ fixtureFiles: ['basic.md'], docFile: 'basic.md' })

  test('mdr --version prints the version document and exits 0', async ({ cli }) => {
    const r = await cli.run(['--version'])
    expect(r.code).toBe(0)
    expect(r.json as VersionResult).toEqual({ ok: true, version: MDR_VERSION })
  })

  test('open --launch starts the system browser only while no tab is connected', async ({ page, server, cli, tmpRoot }) => {
    const log = join(tmpRoot.home, 'launch.jsonl')
    const first = await cli.run(['open', cli.abs('basic.md'), '--launch'], { env: { MDR_TEST_LAUNCH_LOG: log } })
    expect(first.ok, first.stdout + first.stderr).toBe(true)
    expect(first.json).toMatchObject({ navigated: false, launched: true })
    const url = (first.json as OpenResult).url
    expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { url: string }).url)).toEqual([url])
    // a tab is open now: open navigates it and starts no browser
    await openEditor(page, { port: server.port, file: 'basic.md' })
    await expect.poll(async () => {
      const again = await cli.run(['open', cli.abs('basic.md'), '--launch'], { env: { MDR_TEST_LAUNCH_LOG: log } })
      return (again.json as OpenResult).navigated
    }).toBe(true)
    const last = await cli.run(['open', cli.abs('basic.md'), '--launch'], { env: { MDR_TEST_LAUNCH_LOG: log } })
    expect(last.json).toMatchObject({ navigated: true, launched: false })
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('stop --all stops a foreground server through its shutdown route, and its process exits 0', async ({ cli }) => {
    const other = makeTmpRoot({ name: 'gen-stopall', fixtures: ['basic.md'] })
    try {
      const port = workerPort(6)
      const s = await startServer({ root: other.root, port, home: other.home })
      const r = await cli.run(['stop', '--all'], { env: { MDR_TEST_STOP_ALL_PORTS: `${port}-${port}` } })
      expect(r.ok, r.stdout + r.stderr).toBe(true)
      expect(r.json as StopAllResult).toEqual({ ok: true, all: true, failed: [], stopped: [{ root: other.root, port, pid: s.pid }] })
      const exit = await s.proc.exited
      expect(exit.code).toBe(0)
      expect(existsSync(join(other.root, '.review', 'server.json'))).toBe(false)
    } finally {
      other.cleanup()
    }
  })

  test('MDR_IDLE_EXIT_MIN: a foreground server nothing uses stops itself and exits 0', async ({ cli, tmpRoot }) => {
    test.setTimeout(60_000)
    const port = workerPort(5)
    const proc = cli.spawn(['serve', tmpRoot.root, '--foreground', '--port', String(port)], { env: { MDR_IDLE_EXIT_MIN: '0.03' } })
    await proc.waitFor('"ok":true', { timeoutMs: 15_000 })
    expect(existsSync(join(tmpRoot.root, '.review', 'server.json'))).toBe(true)
    const t0 = Date.now()
    const exit = await proc.exited
    expect(exit.code).toBe(0)
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(exit.stderr).toContain('stopping the server')
    expect(existsSync(join(tmpRoot.root, '.review', 'server.json'))).toBe(false)
  })
})
