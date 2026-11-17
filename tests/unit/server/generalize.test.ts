// tests/unit/server/generalize.test.ts (generalization pass). The server side of "any user": GET /api/me and the
// mdr-user-name / mdr-user-source / mdr-cmd meta tags (resolved per request), `user` on the agent status and pending
// routes, MDR_CMD in the protocol hint, the display name in the copied prompt, and the idle exit (MDR_IDLE_EXIT_MIN):
// no browser stream, waiter or /api request for the window → close('stop'), marker removed, RunningServer.done
// resolved; an open browser stream keeps it up.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import type { HandoffResult, MeResult, PendingResult, StatusResult } from '../../../shared/types'
import { CONSTANTS } from '../../../shared/constants'
import { withProcessEnv } from '../../helpers/userEnv'
import { opKey, sleep, startSrv, type Srv } from './server-kit'

const DOC = 'doc.md'
let srv: Srv | null = null
afterEach(async () => {
  await srv?.close().catch(() => undefined)
  srv = null
})

const metaContent = (html: string, name: string): string | null => new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html)?.[1] ?? null

describe('identity on the wire', () => {
  it('GET /api/me (browser route): the display name and its source, re-read per request', async () => {
    srv = await startSrv({ files: { [DOC]: '# Doc\n\nHello there.\n' } })
    const a = await srv.web<MeResult>('GET', '/api/me')
    expect(a.status).toBe(200)
    expect(S.MeResultSchema.safeParse(a.json).success).toBe(true)
    expect(a.json).toEqual({ ok: true, displayName: 'TJ', source: 'env' })
    const b = await withProcessEnv({ MDR_USER_NAME: 'Ana Díaz' }, () => srv!.web<MeResult>('GET', '/api/me'))
    expect(b.json).toEqual({ ok: true, displayName: 'Ana Díaz', source: 'env' })
    // it is a browser route: the token is required
    const r = await fetch(`http://${CONSTANTS.HOST}:${srv.port}/api/me`, { headers: { 'X-MDR-Client': 'web' } })
    expect(r.status).toBe(401)
  })

  it('the page carries mdr-user-name, mdr-user-source and mdr-cmd (escaped)', async () => {
    srv = await startSrv({ files: { [DOC]: '# Doc\n' } })
    const html = await withProcessEnv({ MDR_USER_NAME: 'Ana "AD" <Díaz>', MDR_CMD: 'node /opt/mdr/cli.js' }, async () => (await fetch(`${srv!.origin}/?file=${DOC}`)).text())
    expect(metaContent(html, 'mdr-user-name')).toBe('Ana &quot;AD&quot; &lt;Díaz&gt;')
    expect(metaContent(html, 'mdr-user-source')).toBe('env')
    expect(metaContent(html, 'mdr-cmd')).toBe('node /opt/mdr/cli.js')
    const plain = await (await fetch(`${srv.origin}/?file=${DOC}`)).text()
    expect(metaContent(plain, 'mdr-user-name')).toBe('TJ')
    expect(metaContent(plain, 'mdr-cmd')).toBe('mdr')
  })

  it('agent status and pending carry `user`; the stored actor id stays TJ', async () => {
    srv = await startSrv({ files: { [DOC]: '# Doc\n\nHello there.\n' } })
    const st = await withProcessEnv({ MDR_USER_NAME: 'Ana' }, () => srv!.agent<StatusResult>('GET', `/api/agent/status?file=${DOC}`))
    expect(S.StatusResultSchema.safeParse(st.json).success).toBe(true)
    expect(st.json.user).toEqual({ displayName: 'Ana', source: 'env' })
    const p = await srv.agent<PendingResult>('GET', `/api/agent/pending?file=${DOC}`)
    expect(S.PendingResultSchema.safeParse(p.json).success).toBe(true)
    expect(p.json.user).toEqual({ displayName: 'TJ', source: 'env' })
  })

  it('MDR_CMD names the command in the protocol hint and the copied prompt; the prompt names the user', async () => {
    srv = await startSrv({ files: { [DOC]: '# Doc\n\nHello there.\n' } })
    await withProcessEnv({ MDR_CMD: 'npx -y mdr', MDR_USER_NAME: 'Ana' }, async () => {
      const r = await fetch(`http://${CONSTANTS.HOST}:${srv!.port}/api/agent/status?file=${DOC}`, {
        headers: { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': '999', Authorization: `Bearer ${srv!.token}` },
      })
      expect(r.status).toBe(426)
      expect(((await r.json()) as { error: { hint: string } }).error.hint).toBe(`npx -y mdr serve ${srv!.root} --restart`)
      const h = await srv!.web<HandoffResult>('POST', `/api/handoff?file=${DOC}`, { opKey: opKey(), clientDecision: 'clipboard' })
      expect(h.status).toBe(200)
      const [first, second] = h.json.prompt.split('\n')
      expect(first).toMatch(/^\[doc-review\] Ana sent `doc\.md` back to you \(round #1: /)
      expect(second).toBe(`Run: npx -y mdr pending "${srv!.path(DOC)}" --root "${srv!.root}"`)
    })
  })
})

describe('idle exit (MDR_IDLE_EXIT_MIN)', () => {
  it('with nothing connected the server stops itself: done resolves, the marker is removed, the port is free', async () => {
    srv = await withProcessEnv({ MDR_IDLE_EXIT_MIN: '0.01' }, () => startSrv({ files: { [DOC]: '# Doc\n' } }))
    const marker = join(srv.root, '.review', 'server.json')
    expect(existsSync(marker)).toBe(true)
    const t0 = Date.now()
    await Promise.race([srv.server.done, sleep(5_000).then(() => {
      throw new Error('the server did not stop itself')
    })])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(existsSync(marker)).toBe(false)
    await expect(fetch(`${srv.origin}/api/health`)).rejects.toThrow()
  })

  it('an open browser stream keeps it up past the window; closing it starts the clock again', async () => {
    srv = await withProcessEnv({ MDR_IDLE_EXIT_MIN: '0.01' }, () => startSrv({ files: { [DOC]: '# Doc\n' } }))
    let stopped = false
    void srv.server.done!.then(() => {
      stopped = true
    })
    const rec = await srv.sse(DOC)
    await sleep(1_500)
    expect(stopped).toBe(false)
    expect((await fetch(`${srv.origin}/api/health`)).status).toBe(200)
    rec.close()
    await Promise.race([srv.server.done, sleep(5_000)])
    expect(stopped).toBe(true)
  })

  it('0 means never', async () => {
    srv = await withProcessEnv({ MDR_IDLE_EXIT_MIN: '0' }, () => startSrv({ files: { [DOC]: '# Doc\n' } }))
    let stopped = false
    void srv.server.done!.then(() => {
      stopped = true
    })
    await sleep(800)
    expect(stopped).toBe(false)
  })

  it('health probes (other roots\' discovery) never count as use; any other /api request does', async () => {
    srv = await withProcessEnv({ MDR_IDLE_EXIT_MIN: '0.01' }, () => startSrv({ files: { [DOC]: '# Doc\n' } }))
    let stopped = false
    void srv.server.done!.then(() => {
      stopped = true
    })
    const s = srv
    const poll = async (path: string, ms: number): Promise<void> => {
      const end = Date.now() + ms
      while (Date.now() < end && !stopped) {
        if (path === '/api/health') await fetch(`${s.origin}${path}`).catch(() => undefined)
        else await s.web('GET', path).catch(() => undefined)
        await sleep(100)
      }
    }
    await poll('/api/me', 1_500)
    expect(stopped).toBe(false)
    await poll('/api/health', 3_000)
    expect(stopped).toBe(true)
  })
})
