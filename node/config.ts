// node/config.ts (generalization pass, 2026-10-16). Per-user mdr settings for anyone, not just TJ:
//
// - the config file: ~/.config/mdr/config.json (%APPDATA%\mdr\config.json on Windows), JSON
//   { "displayName"?: string, "protectedSegments"?: string[] }, written by `mdr config set|unset`; unknown keys are kept.
// - protectedSegments(): MDR_PROTECTED_SEGMENTS (comma list; set but empty = none) > config.json > [] (the default:
//   nothing is protected beyond `/` and $HOME, and the subtree walk is skipped). TJ's own setup sets
//   MDR_PROTECTED_SEGMENTS=approvals,legal/signed,legal/filed,registry (CONTRACT_CHANGES.md).
// - mdrCmd(): MDR_CMD || 'mdr', the command every agent-facing hint and the wake prompt print (a plugin install may run
//   mdr through `node <path>/cli.js` or `npx`).
// - idleExitMs(): MDR_IDLE_EXIT_MIN (default 240; 0 = never) as milliseconds, for the server's idle exit.
// Reads take `env` explicitly (the CLI passes its io.env, the server process.env), so tests stay hermetic.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { renameWithRetry } from './rename'
import { shellCmd } from '../shared/handoff-prompt'

export type Env = Record<string, string | undefined>

export interface MdrConfigFile {
  displayName?: string
  protectedSegments?: string[]
  /** true once Claude offered the 2-minute tour (taken or declined): never offered again. `mdr tour` still runs. */
  tourDone?: boolean
  [k: string]: unknown
}

export const DEFAULT_IDLE_EXIT_MIN = 240

/** The user's home directory as `env` sees it (HOME, USERPROFILE on Windows), else os.homedir(). */
export function homeOf(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const h = platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME
  return h && h.trim() !== '' ? h : homedir()
}

/** ~/.config/mdr/config.json, or %APPDATA%\mdr\config.json on Windows. */
export function configPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const appData = env.APPDATA && env.APPDATA.trim() !== '' ? env.APPDATA : join(homeOf(env, platform), 'AppData', 'Roaming')
    return join(appData, 'mdr', 'config.json')
  }
  return join(homeOf(env, platform), '.config', 'mdr', 'config.json')
}

const cache = new Map<string, { mtimeMs: number; size: number; data: MdrConfigFile }>()

/** The parsed config file; {} when absent or unreadable. A file that isn't a JSON object reads as {} too. */
export function readConfig(env: Env = process.env, platform: NodeJS.Platform = process.platform): MdrConfigFile {
  const p = configPath(env, platform)
  let st
  try {
    st = statSync(p)
  } catch {
    cache.delete(p)
    return {}
  }
  const hit = cache.get(p)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
  let data: MdrConfigFile = {}
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) data = v as MdrConfigFile
  } catch {
    data = {}
  }
  cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, data })
  return data
}

/** Merge `patch` into the config file (undefined deletes a key); atomic temp + rename. Returns the new contents. */
export function writeConfig(patch: Partial<Record<keyof MdrConfigFile, unknown>>, env: Env = process.env, platform: NodeJS.Platform = process.platform): MdrConfigFile {
  const p = configPath(env, platform)
  const next: MdrConfigFile = { ...readConfig(env, platform) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameWithRetry(tmp, p)
  cache.delete(p)
  return next
}

/** Normalize one protected segment: POSIX separators, no leading/trailing slash; '' for anything unusable. */
export function normalizeSegment(s: string): string {
  const parts = s.trim().replace(/\\/g, '/').split('/').filter((x) => x !== '' && x !== '.')
  if (parts.some((x) => x === '..')) return ''
  return parts.join('/')
}

export function parseSegments(list: readonly unknown[] | string): string[] {
  const raw = typeof list === 'string' ? list.split(',') : list.filter((x): x is string => typeof x === 'string')
  const out: string[] = []
  for (const r of raw) {
    const n = normalizeSegment(r)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

export type SegmentsSource = 'env' | 'config' | 'default'

export function protectedSegmentsInfo(env: Env = process.env, platform: NodeJS.Platform = process.platform): { segments: string[]; source: SegmentsSource } {
  const e = env.MDR_PROTECTED_SEGMENTS
  if (e !== undefined) return { segments: parseSegments(e), source: 'env' }
  const c = readConfig(env, platform).protectedSegments
  if (Array.isArray(c)) return { segments: parseSegments(c), source: 'config' }
  return { segments: [], source: 'default' }
}

/** MDR_PROTECTED_SEGMENTS > config.json protectedSegments > [] (nothing protected beyond / and $HOME). */
export function protectedSegments(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  return protectedSegmentsInfo(env, platform).segments
}

/** Whether the tour was offered already (MDR_TOUR_DONE=1|0 overrides the file, for tests and admins). */
export function tourDone(env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const e = env.MDR_TOUR_DONE?.trim()
  if (e === '1' || e === 'true') return true
  if (e === '0' || e === 'false') return false
  return readConfig(env, platform).tourDone === true
}

/** The command agent-facing hints print: MDR_CMD (trimmed) or 'mdr'. */
export function mdrCmd(env: Env = process.env): string {
  const c = env.MDR_CMD?.trim()
  return c ? shellCmd(c) : 'mdr'
}

/** MDR_IDLE_EXIT_MIN in ms (default 240 min); 0 = never. Fractions allowed (tests); anything unparsable = default. */
export function idleExitMs(env: Env = process.env): number {
  const raw = env.MDR_IDLE_EXIT_MIN
  const n = raw === undefined || raw.trim() === '' ? DEFAULT_IDLE_EXIT_MIN : Number(raw)
  const min = Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_EXIT_MIN
  return Math.round(min * 60_000)
}
