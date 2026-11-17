// tests/e2e/int-smoke.spec.ts (integrator, day 0; CONTRACTS §1.3 "smoke", §2.5 M0 gate, D42).
//
// `npm run smoke` = build:e2e, then this spec. A scaffold that doesn't build or boot never fans out:
//   1. the built `.e2e-dist/cli.js serve <tmp> --foreground --port <p>` answers /api/health for this root;
//   2. it serves `/?file=<fixture>` with every `<meta name="mdr-*">` tag injected (§12.0.2) and the §12.0.1 host ids
//      present; an invalid ?file= still answers 200 with mdr-file empty and mdr-file-error set;
//   3. `cli.js batch <fixture>` with an empty BatchRequest prints exactly ONE JSON document on stdout with an
//      ERROR_TABLE exit code (a CliErr until M2 mounts the agent routes; a BatchResult after).
// Checks 1–3 are pure HTTP + CLI, so the gate runs without a browser. A fourth check loads the page in Chromium and
// asserts the shell hosts survive the harness boot. It runs on Playwright's Chromium, or on the installed Google Chrome
// when that build is absent (tests/helpers/browser.ts), and is skipped with the reason only when neither exists.
import { ERROR_TABLE } from '../../shared/types'
import type { CliErr, ErrorCode } from '../../shared/types'
import { BatchResultSchema, CliErrSchema, HealthSchema } from '../../shared/schemas'
import { DEFAULT_DOC } from '../fixtures/index'
import { browserChoice } from '../helpers/browser'
import { expect, test } from './fixtures'

test.use({ serverKind: 'real', fixtureFiles: 'all' })

const META_NAMES = ['mdr-token', 'mdr-root', 'mdr-root-hash', 'mdr-port', 'mdr-file', 'mdr-version', 'mdr-protocol', 'mdr-fingerprint', 'mdr-test-hooks']
const HOST_IDS = ['mdr-app', 'mdr-toolbar-host', 'mdr-scroll', 'mdr-editor-host']
const BROWSER = browserChoice()

const metaContent = (html: string, name: string): string | null => {
  const m = new RegExp(`<meta[^>]*name="${name}"[^>]*>`).exec(html)
  if (!m) return null
  const c = /content="([^"]*)"/.exec(m[0])
  return c ? c[1]! : ''
}

test.describe('int-smoke (M0 gate)', () => {
  test('health answers for this root', async ({ server, tmpRoot }) => {
    const r = await fetch(`${server.origin}/api/health`)
    expect(r.status).toBe(200)
    const h = (await r.json()) as unknown
    const parsed = HealthSchema.safeParse(h)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(h).toMatchObject({ ok: true, app: 'mdr', root: tmpRoot.root, port: server.port })
  })

  test('the SPA is served with the mdr meta tags injected and the shell host ids present', async ({ server, tmpRoot }) => {
    const r = await fetch(`${server.origin}/?file=${encodeURIComponent(DEFAULT_DOC)}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control') ?? '').toContain('no-store')
    const html = await r.text()
    expect(html).not.toContain('<!--mdr:meta-->')
    for (const name of META_NAMES) expect(metaContent(html, name), `meta ${name}`).not.toBeNull()
    expect(metaContent(html, 'mdr-file')).toBe(DEFAULT_DOC)
    expect(metaContent(html, 'mdr-root')).toBe(tmpRoot.root)
    expect(metaContent(html, 'mdr-port')).toBe(String(server.port))
    expect(metaContent(html, 'mdr-token')).toBe(server.token)
    expect(metaContent(html, 'mdr-test-hooks')).toBe('1')
    expect(metaContent(html, 'mdr-file-error')).toBeNull()
    for (const id of HOST_IDS) expect(html, `#${id}`).toContain(`id="${id}"`)
    expect(html).toMatch(/<script type="module"[^>]*src="[^"]+\.js"/)

    const bad = await fetch(`${server.origin}/?file=${encodeURIComponent('nope.md')}`)
    expect(bad.status).toBe(200)
    const badHtml = await bad.text()
    expect(metaContent(badHtml, 'mdr-file')).toBe('')
    expect(metaContent(badHtml, 'mdr-file-error')).toBe('FILE_NOT_FOUND')
  })

  test('cli.js batch with an empty BatchRequest prints exactly one JSON document with an ERROR_TABLE exit code', async ({ server, cli }) => {
    void server
    const r = await cli.batch(DEFAULT_DOC, { ops: [] })
    expect(r.docs, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(1)
    const exits = new Set([0, ...Object.values(ERROR_TABLE).map((e) => e.exit)])
    expect(r.code).not.toBeNull()
    expect(exits.has(r.code!)).toBe(true)
    if (r.ok) {
      expect(r.code).toBe(0)
      const p = BatchResultSchema.safeParse(r.json)
      expect(p.success, JSON.stringify(p.error?.issues)).toBe(true)
    } else {
      const p = CliErrSchema.safeParse(r.json)
      expect(p.success, JSON.stringify(p.error?.issues)).toBe(true)
      const code = (r.json as CliErr).error.code as ErrorCode
      expect(r.code).toBe(ERROR_TABLE[code].exit)
    }
  })

  test.describe('in the browser', () => {
    // a describe-level skip, so the `page` fixture never tries to launch a missing browser
    test.skip(!BROWSER.available, BROWSER.reason)
    test('the page boots in the browser with the shell hosts intact', async ({ server, page }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${server.origin}/?file=${encodeURIComponent(DEFAULT_DOC)}`, { waitUntil: 'load' })
      for (const id of ['mdr-toolbar-host', 'mdr-scroll', 'mdr-editor-host']) await expect(page.locator(`#${id}`)).toHaveCount(1)
      await expect(page.locator('[data-testid="mdr-topbar"]')).toHaveCount(1)
      await expect(page.locator('[data-testid="mdr-rail"]')).toHaveCount(1)
      expect(errors, errors.join('\n')).toEqual([])
    })
  })
})
