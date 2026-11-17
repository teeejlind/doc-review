// cli/http.ts (P4). The agent-route HTTP client (CONTRACTS §8.1 step 4, §8.4, §9.2 "Verification on every HTTP call").
//
// Every request carries X-MDR-Client: cli, X-MDR-Protocol: 2, the bearer token from server.json, and no Origin. Every
// response must carry X-MDR-Root-Hash = sha256(root), else ROOT_MISMATCH and the CLI never proceeds. A server that
// reports another protocol in /api/health is refused before any call (PROTOCOL_MISMATCH, hint `mdr serve <root>
// --restart`); a version-only skew becomes a VERSION_SKEW warning on results that carry warnings.
import type { Health, ServerMarker, Warning } from '../shared/types'
import { CONSTANTS, PROTOCOL } from '../shared/constants'
import { MDR_VERSION } from '../shared/version'
import { mdrCmd } from '../node/config'
import { rootHashOf } from '../node/root'
import { cliErr, CliExit, fromHttp } from './output'

export interface AgentConn {
  root: string
  port: number
  token: string
  health: Health
}

export function connOf(root: string, d: { port: number; health: Health; marker: ServerMarker }): AgentConn {
  return { root, port: d.port, token: d.marker.token, health: d.health }
}

export function agentHeaders(token: string, protocol: number = PROTOCOL): Record<string, string> {
  return { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(protocol), Authorization: `Bearer ${token}` }
}

export function protocolMismatch(root: string, got: number): CliExit {
  return cliErr('PROTOCOL_MISMATCH', `the mdr server for ${root} speaks protocol ${got}; this CLI speaks ${PROTOCOL}`, {
    hint: `${mdrCmd()} serve ${root} --restart`, details: { protocol: got, expected: PROTOCOL },
  })
}

export function checkProtocol(conn: AgentConn): void {
  if (conn.health.protocol !== PROTOCOL) throw protocolMismatch(conn.root, conn.health.protocol)
}

export function checkRootHash(got: string | null | undefined, root: string, port: number): void {
  if (got !== rootHashOf(root)) throw cliErr('ROOT_MISMATCH', `the server on port ${port} does not serve ${root}`, { details: { port } })
}

/** VERSION_SKEW when the server's version differs from this CLI's (protocol equal). */
export function skewWarnings(conn: AgentConn): Warning[] {
  return conn.health.version === MDR_VERSION ? [] : [{ code: 'VERSION_SKEW', message: `server ${conn.health.version}, CLI ${MDR_VERSION}` }]
}

export interface CallOptions {
  /** Send this protocol instead of ours (`serve --restart` stopping an incompatible server). Skips the protocol check. */
  protocol?: number
  timeoutMs?: number
}

/** One agent call. Resolves the ok body; throws CliExit for an ApiError (1:1), a root-hash mismatch or a dead socket. */
export async function agentCall<T>(conn: AgentConn, method: 'GET' | 'POST', path: string, body?: unknown, o: CallOptions = {}): Promise<T> {
  if (o.protocol === undefined) checkProtocol(conn)
  let res: Response
  try {
    res = await fetch(`http://${CONSTANTS.HOST}:${conn.port}${path}`, {
      method,
      headers: { ...agentHeaders(conn.token, o.protocol ?? PROTOCOL), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(o.timeoutMs ? { signal: AbortSignal.timeout(o.timeoutMs) } : {}),
    })
  } catch (e) {
    throw cliErr('INTERNAL', `request to the mdr server on port ${conn.port} failed: ${(e as Error).message}`, { details: { port: conn.port } })
  }
  checkRootHash(res.headers.get('x-mdr-root-hash'), conn.root, conn.port)
  const r = fromHttp(res.status, await res.text())
  if (r.code !== 0) throw r
  return r.doc as T
}

export const q = (params: Record<string, string | number | boolean | undefined>): string => {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) if (v !== undefined) parts.push(`${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}
