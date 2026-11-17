// cli/discover.ts (P4). Resolving a command's <file> or <root|file> argument to (abs, root, rel), and ServerInfo from
// discovery (CONTRACTS §9.1 "<file> is absolute or relative to the cwd", §9.2 resolveRoot, D23).
import { statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { ServerInfo } from '../shared/types'
import { CONSTANTS } from '../shared/constants'
import { isInside, realId, resolveRoot, type Discovery } from '../node/root'
import { cliErr } from './output'

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'))

export interface Located {
  /** realpath + NFC of the file. */
  abs: string
  /** The served root (realId). */
  root: string
  /** POSIX path of the file relative to the root (what `?file=` carries). */
  rel: string
}

/** <file> → abs, root (--root > a live marker above it > its directory), rel. FILE_NOT_FOUND / PATH_OUTSIDE_ROOT. */
export function locateFile(fileArg: string, cwd: string, rootFlag?: string): Located {
  let abs: string
  try {
    abs = realId(resolve(cwd, fileArg))
  } catch {
    throw cliErr('FILE_NOT_FOUND', `${fileArg} does not exist`)
  }
  let root: string
  try {
    root = resolveRoot(abs, rootFlag === undefined ? undefined : resolve(cwd, rootFlag))
  } catch {
    throw cliErr('FILE_NOT_FOUND', `--root ${rootFlag} does not exist`)
  }
  if (!isInside(root, abs) || abs === root) throw cliErr('PATH_OUTSIDE_ROOT', `${abs} is outside the served root ${root}`)
  if (!/\.(md|markdown)$/i.test(abs)) throw cliErr('BAD_REQUEST', `${fileArg}: only .md and .markdown files are reviewed`)
  return { abs, root, rel: toPosix(relative(root, abs)).normalize('NFC') }
}

/** [<root|file>] → the root: --root, else a directory as given, else the file's resolved root, else the cwd. */
export function locateRoot(target: string | undefined, cwd: string, rootFlag?: string): string {
  if (rootFlag !== undefined) {
    try {
      return realId(resolve(cwd, rootFlag))
    } catch {
      throw cliErr('FILE_NOT_FOUND', `--root ${rootFlag} does not exist`)
    }
  }
  const p = resolve(cwd, target ?? '.')
  let st
  try {
    st = statSync(p)
  } catch {
    throw cliErr('FILE_NOT_FOUND', `${target ?? cwd} does not exist`)
  }
  return st.isDirectory() ? realId(p) : resolveRoot(realId(p))
}

export function urlFor(port: number, rel?: string): string {
  return `http://${CONSTANTS.HOST}:${port}/${rel === undefined ? '' : `?file=${encodeURIComponent(rel)}`}`
}

export function serverInfo(d: Discovery): ServerInfo {
  if (d.state === 'down') return { state: 'down', port: null, url: null }
  return { state: 'up', port: d.port, url: urlFor(d.port), pid: d.health.pid, version: d.health.version, protocol: d.health.protocol }
}
