// cli/commands/review.ts (P4). open, arm, disarm, status (CONTRACTS §9.3, §9.4, §9.8, §9.9, §9.9.1, D39, D48).
//
// open / arm ensure the server (they are the only commands besides serve that start one), apply --suggest-only /
// --allow-edits through POST /api/agent/policy, then send POST /api/agent/arm right before printing a fresh
// WaiterSpec (presence turn | none → grace, D48). With the clipboard primary (§0.1) they print `waiter: null` and send
// no arm, since no loop is coming. open also asks the server to navigate the human's most recent tab (POST
// /api/agent/open); only `--launch` starts a system browser, and only when no tab was there to navigate.
// Generalization pass: open and status carry `user` (the human's display name, from the server when it is up), and
// open / arm say why in `waiterReason` when `waiter` is null (clipboard-primary build, or no POSIX shell on Windows).
import type { ArmResult, ArmRouteResult, DisarmResult, OpenResult, Presence, ReviewPolicy, StatusResult, TourOfferResult } from '../../shared/types'
import { tourDone, writeConfig } from '../../node/config'
import { assertServable, ensureServer } from '../../node/root'
import { serverInfo, urlFor, type Located } from '../discover'
import { withStore } from '../direct'
import { agentCall, checkProtocol, connOf, q, type AgentConn } from '../http'
import { cliErr, CliExit } from '../output'
import { launchBrowser } from '../launch'
import { cliPlatform, waiterSpec, waiterUnavailableReason, waitTimeoutS } from '../waiter-loop'
import { fileOf, flag, intOpt, localUser, serverFor, withSkew, type Ctx } from './common'

function policyFlag(ctx: Ctx): boolean | undefined {
  const s = flag(ctx, 'suggestOnly')
  const a = flag(ctx, 'allowEdits')
  if (s && a) throw cliErr('USAGE', 'pass --suggest-only or --allow-edits, not both')
  return s ? true : a ? false : undefined
}

async function ensure(ctx: Ctx, at: Located): Promise<{ conn: AgentConn; port: number; started: boolean }> {
  assertServable(at.root, at.abs)
  const s = await ensureServer(at.root)
  ctx.verbose(s.started ? `started the mdr server for ${at.root} on port ${s.port}` : `adopted the mdr server on port ${s.port}`)
  const conn = connOf(at.root, s)
  checkProtocol(conn)
  return { conn, port: s.port, started: s.started }
}

async function applyPolicy(conn: AgentConn, at: Located, suggestOnly: boolean | undefined): Promise<void> {
  if (suggestOnly === undefined) return
  await agentCall(conn, 'POST', '/api/agent/policy', { file: at.rel, suggestOnly })
}

async function status(conn: AgentConn, at: Located): Promise<StatusResult> {
  return agentCall<StatusResult>(conn, 'GET', `/api/agent/status${q({ file: at.rel })}`)
}

/** POST /api/agent/arm, then a fresh spec; null (and no arm) when no loop can run, with the reason. */
async function armAndSpec(ctx: Ctx, conn: AgentConn, at: Located, port: number): Promise<{ waiter: OpenResult['waiter']; presence: Presence | null; reason: string | null }> {
  const reason = waiterUnavailableReason(ctx.io.env)
  if (reason !== null) return { waiter: null, presence: null, reason }
  const armed = await agentCall<ArmRouteResult>(conn, 'POST', '/api/agent/arm', { file: at.rel })
  const self = ctx.io.self()
  const spec = waiterSpec({
    node: self.node, execArgv: self.execArgv, cli: self.script, abs: at.abs, root: at.root, file: at.rel, port, timeoutS: waitTimeoutS(ctx.io.env),
  })
  return { waiter: spec, presence: armed.presence, reason: null }
}

export async function runOpen(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const suggestOnly = policyFlag(ctx)
  // the first-ever review on this computer: open nothing yet, so Claude can offer the tour first (the skill then runs
  // `mdr tour`, or `mdr config set tour done` and this same open again)
  if (flag(ctx, 'skipTour')) {
    try {
      writeConfig({ tourDone: true }, ctx.io.env, cliPlatform(ctx.io.env))
    } catch (e) {
      ctx.verbose(`could not record that the tour was declined: ${(e as Error).message}`)
    }
  } else if (flag(ctx, 'offerTour') && !tourDone(ctx.io.env, cliPlatform(ctx.io.env))) {
    const offer: TourOfferResult = { ok: true, tour: 'offer', opened: false, file: at.rel, abs: at.abs, root: at.root, user: localUser(ctx) }
    return new CliExit(offer, 0)
  }
  const { conn, port } = await ensure(ctx, at)
  await applyPolicy(conn, at, suggestOnly)
  const nav = await agentCall<{ ok: true; connectedTabs: number; navigated: boolean }>(conn, 'POST', '/api/agent/open', { file: at.rel })
  const st = await status(conn, at)
  const { waiter, presence, reason } = await armAndSpec(ctx, conn, at, port)
  const policy: ReviewPolicy = { suggestOnly: st.policy.suggestOnly }
  const url = urlFor(port, at.rel)
  let launched: boolean | undefined
  if (flag(ctx, 'launch')) {
    if (nav.navigated) {
      launched = false
      ctx.verbose('--launch: a connected tab was navigated, so no system browser was started')
    } else {
      const r = await launchBrowser(url, { env: ctx.io.env, platform: cliPlatform(ctx.io.env) })
      launched = r.launched
      if (r.error) ctx.verbose(`--launch: the system browser did not start: ${r.error}`)
    }
  }
  const out: OpenResult = {
    ok: true, via: 'server', file: at.rel, abs: at.abs, root: at.root, port, url, rev: st.rev,
    connectedTabs: nav.connectedTabs, navigated: nav.navigated, waiter, ...(reason !== null ? { waiterReason: reason } : {}),
    presence: presence ?? st.presence, policy, user: st.user ?? localUser(ctx), ...(launched !== undefined ? { launched } : {}),
  }
  return new CliExit(out, 0)
}

export async function runArm(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const suggestOnly = policyFlag(ctx)
  const { conn, port } = await ensure(ctx, at)
  await applyPolicy(conn, at, suggestOnly)
  const { waiter, presence, reason } = await armAndSpec(ctx, conn, at, port)
  const st = await status(conn, at)
  const p = presence ?? st.presence
  const out: ArmResult = {
    ok: true, waiter, ...(reason !== null ? { waiterReason: reason } : {}), attached: p.waiter === 'connected', presence: p,
    server: { state: 'up', port, url: urlFor(port), pid: conn.health.pid, version: conn.health.version, protocol: conn.health.protocol },
    policy: { suggestOnly: st.policy.suggestOnly },
  }
  return new CliExit(out, 0)
}

export async function runDisarm(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const up = await serverFor(ctx, at.root)
  if (!up) {
    const out: DisarmResult = { ok: true, file: at.rel, disarmed: false }
    return new CliExit(out, 0)
  }
  return new CliExit(await agentCall<DisarmResult>(up.conn, 'POST', '/api/agent/disarm', { file: at.rel }), 0)
}

export async function runStatus(ctx: Ctx): Promise<CliExit> {
  const at = fileOf(ctx)
  const waitS = intOpt(ctx, 'waitWaiter', '--wait-waiter', 0)
  const up = await serverFor(ctx, at.root)
  if (up) {
    const deadline = Date.now() + (waitS ?? 0) * 1000
    let st = await status(up.conn, at)
    while (waitS !== undefined && st.presence.waiter !== 'connected' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))))
      st = await status(up.conn, at)
    }
    return new CliExit(withSkew(st.user ? st : { ...st, user: localUser(ctx) }, up.conn), 0)
  }
  const base = await withStore(ctx.io, at, { readOnly: true }, (s) => s.agent.status())
  const out: StatusResult = { ...base, server: serverInfo({ state: 'down', freePort: null }), presence: { waiter: 'none' }, activity: null, user: localUser(ctx) }
  return new CliExit(out, 0)
}
