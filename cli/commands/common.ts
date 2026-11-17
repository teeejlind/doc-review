// cli/commands/common.ts (P4). What every command shares: the parsed command, the io, option readers, and the
// "server up → HTTP, server down → direct" switch (CONTRACTS §9.3).
import type { UserIdentity, Warning } from '../../shared/types'
import { resolveDisplayName } from '../../node/identity'
import { discover, type Discovery } from '../../node/root'
import type { ParsedCommand } from '../args'
import { locateFile, type Located } from '../discover'
import { connOf, skewWarnings, type AgentConn } from '../http'
import type { CliIo } from '../io'
import { cliErr } from '../output'
import { cliPlatform } from '../waiter-loop'

export interface Ctx {
  io: CliIo
  cmd: ParsedCommand
  verbose(msg: string): void
}

export const opt = <T = string>(ctx: Ctx, name: string): T | undefined => ctx.cmd.opts[name] as T | undefined
export const flag = (ctx: Ctx, name: string): boolean => ctx.cmd.opts[name] === true

export function arg(ctx: Ctx, i: number, what: string): string {
  const v = ctx.cmd.args[i]
  if (v === undefined || v === '') throw cliErr('USAGE', `mdr ${ctx.cmd.name}: missing <${what}>`)
  return v
}

/** An integer option (>= min) or USAGE. */
export function intOpt(ctx: Ctx, name: string, flagName: string, min = 0): number | undefined {
  const v = opt(ctx, name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw cliErr('USAGE', `${flagName} must be an integer >= ${min}, got ${JSON.stringify(v)}`)
  return n
}

export function fileOf(ctx: Ctx, i = 0): Located {
  return locateFile(arg(ctx, i, 'file'), ctx.io.cwd, opt(ctx, 'root'))
}

/** Long text never goes through shell quoting: `--x -` reads stdin, `--x-file F` reads a file (§9.1). */
export async function textOpt(ctx: Ctx, value: string, fileFlag: string | null, flagName: string): Promise<string | undefined> {
  const v = opt(ctx, value)
  const f = fileFlag ? opt(ctx, fileFlag) : undefined
  if (v !== undefined && f !== undefined) throw cliErr('USAGE', `pass ${flagName} or ${flagName}-file, not both`)
  if (f !== undefined) {
    try {
      return ctx.io.readFile(f)
    } catch (e) {
      throw cliErr('USAGE', `cannot read ${f}: ${(e as Error).message}`)
    }
  }
  if (v === '-') return ctx.io.readStdin()
  return v
}

export type Conn = { d: Extract<Discovery, { state: 'up' }>; conn: AgentConn }

/** The running same-root server, or null (then the command goes direct). */
export async function serverFor(ctx: Ctx, root: string): Promise<Conn | null> {
  const d = await discover(root)
  if (d.state !== 'up') {
    ctx.verbose(`no mdr server for ${root}: direct mode`)
    return null
  }
  ctx.verbose(`mdr server for ${root} on port ${d.port}`)
  return { d, conn: connOf(root, d) }
}

/** Append VERSION_SKEW to a result that carries `warnings`. */
export function withSkew<T>(doc: T, conn: AgentConn | null): T {
  if (!conn) return doc
  const w = skewWarnings(conn)
  const d = doc as { warnings?: Warning[] }
  if (!w.length || !d || !Array.isArray(d.warnings)) return doc
  return { ...doc, warnings: [...d.warnings, ...w] }
}

/** The human's display name as this CLI resolves it (direct mode, or a server that predates `user`). */
export function localUser(ctx: Ctx): UserIdentity {
  return resolveDisplayName({ env: ctx.io.env, platform: cliPlatform(ctx.io.env) })
}
