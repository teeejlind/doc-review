// node/identity.ts (generalization pass, 2026-10-16). The human's DISPLAY name, for every place that shows or says it.
//
// Storage never changes: the browser's actor id stays 'TJ' (shared/types Author, sidecar `by: "TJ"`), the legacy id
// for "the human". Only what people and Claude read resolves through here, first hit wins:
//   1 MDR_USER_NAME                               (source 'env'; TJ keeps "TJ" with MDR_USER_NAME=TJ)
//   2 config.json { "displayName" }               (source 'config'; `mdr config set name "<name>"`)
//   3 user.name from ~/.gitconfig, then $XDG_CONFIG_HOME/git/config (~/.config/git/config)   (source 'git';
//     the files are parsed here, git is never spawned)
//   4 the account's full name: macOS `id -F`, Windows the account's display name via PowerShell
//                                                  (source 'os-full-name'; memoized per process)
//   5 the OS user name                             (source 'os-username')
//   6 "You"                                       (source 'default')
// A value is trimmed, control characters become spaces, runs of whitespace collapse, and it is capped at 64 code points;
// an empty result falls through to the next source.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { DisplayNameSource, UserIdentity } from '../shared/types'
import { homeOf, readConfig, type Env } from './config'

export type { DisplayNameSource, UserIdentity }

export const DEFAULT_DISPLAY_NAME = 'You'
export const MAX_DISPLAY_NAME_CHARS = 64

/** Trim, control characters → space, collapse whitespace, cap at 64 code points. '' when nothing is left. */
export function cleanName(s: unknown): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(t).slice(0, MAX_DISPLAY_NAME_CHARS).join('').trim()
}

/** One git-config value: quotes removed, \" \\ \n \t \b unescaped, an unquoted # or ; starts a comment, outer whitespace trimmed. */
function gitValue(raw: string): string {
  let out = ''
  let ws = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '\\' && i + 1 < raw.length) {
      const n = raw[++i]!
      out += ws + (n === 'n' ? '\n' : n === 't' ? '\t' : n === 'b' ? '\b' : n)
      ws = ''
      continue
    }
    if (ch === '"') {
      out += ws
      ws = ''
      quoted = !quoted
      continue
    }
    if (!quoted && (ch === '#' || ch === ';')) break
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (out !== '') ws += ch
      continue
    }
    out += ws + ch
    ws = ''
  }
  return out
}

/** `user.name` from git-config text (the last one in the file wins, as in git); null when absent. Sub-sectioned and included files are ignored. */
export function parseGitUserName(text: string): string | null {
  let section = ''
  let name: string | null = null
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i]!
    // a trailing backslash continues the line
    while (/(^|[^\\])(\\\\)*\\$/.test(s) && i + 1 < lines.length) s = s.slice(0, -1) + lines[++i]!
    s = s.trimStart()
    if (s.startsWith('[')) {
      const close = s.indexOf(']')
      if (close < 0) {
        section = ''
        continue
      }
      const m = /^([A-Za-z0-9.-]+)(\s+".*")?$/.exec(s.slice(1, close).trim())
      section = m ? (m[2] ? `${m[1]!.toLowerCase()} ${m[2].trim()}` : m[1]!.toLowerCase()) : ''
      s = s.slice(close + 1).trimStart()
    }
    if (s === '' || s.startsWith('#') || s.startsWith(';')) continue
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(s)
    if (!kv || section !== 'user' || kv[1]!.toLowerCase() !== 'name' || kv[2] === undefined) continue
    name = gitValue(kv[2])
  }
  const c = cleanName(name)
  return c === '' ? null : c
}

/** The global git config files in git's precedence order (the first that names user.name wins). */
export function gitConfigFiles(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = homeOf(env, platform)
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : join(home, '.config')
  return [join(home, '.gitconfig'), join(xdg, 'git', 'config')]
}

export function gitUserName(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  for (const f of gitConfigFiles(env, platform)) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const n = parseGitUserName(text)
    if (n) return n
  }
  return null
}

let fullNameMemo: string | null | undefined

/** Windows: the signed-in account's display name (local, Microsoft or domain account), UTF-8 so "Ana Díaz" survives. */
export const WINDOWS_FULL_NAME_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.DirectoryServices.AccountManagement',
  '[System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName',
].join('; ')

export type RunCommand = (cmd: string, args: readonly string[], timeoutMs: number) => string

const runCommand: RunCommand = (cmd, args, timeoutMs) =>
  execFileSync(cmd, [...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })

/**
 * The account's full name, memoized per process; null on Linux or on any failure. macOS: `id -F`. Windows:
 * PowerShell 5.1 (always installed) asks for the account's display name; it is skipped after 3 s (a domain account
 * with no domain controller in reach) and then the OS user name is used.
 */
export function osFullName(platform: NodeJS.Platform = process.platform, run: RunCommand = runCommand): string | null {
  if (platform !== 'darwin' && platform !== 'win32') return null
  if (fullNameMemo !== undefined && run === runCommand) return fullNameMemo
  let name: string | null
  try {
    name = platform === 'darwin'
      ? cleanName(run('id', ['-F'], 1500)) || null
      : cleanName(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_FULL_NAME_SCRIPT], 3000)) || null
  } catch {
    name = null
  }
  if (run === runCommand) fullNameMemo = name
  return name
}

export function osUserName(env: Env = process.env): string | null {
  const fromEnv = cleanName(env.USER || env.USERNAME || env.LOGNAME || '')
  if (fromEnv) return fromEnv
  try {
    return cleanName(userInfo().username) || null
  } catch {
    return null
  }
}

export interface ResolveOptions {
  env?: Env
  platform?: NodeJS.Platform
  /** Replaces the OS full-name lookup (tests). */
  fullName?: () => string | null
  /** Replaces the OS user name lookup (tests). */
  osUser?: () => string | null
}

/** MDR_USER_NAME > config.json displayName > git user.name > OS full name > OS user name > "You". */
export function resolveDisplayName(o: ResolveOptions = {}): UserIdentity {
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const fromEnv = cleanName(env.MDR_USER_NAME)
  if (fromEnv) return { displayName: fromEnv, source: 'env' }
  const fromConfig = cleanName(readConfig(env, platform).displayName)
  if (fromConfig) return { displayName: fromConfig, source: 'config' }
  const fromGit = gitUserName(env, platform)
  if (fromGit) return { displayName: fromGit, source: 'git' }
  const full = o.fullName ? cleanName(o.fullName() ?? '') || null : osFullName(platform)
  if (full) return { displayName: full, source: 'os-full-name' }
  const user = o.osUser ? cleanName(o.osUser() ?? '') || null : osUserName(env)
  if (user) return { displayName: user, source: 'os-username' }
  return { displayName: DEFAULT_DISPLAY_NAME, source: 'default' }
}

/** resolveDisplayName().displayName over process.env (server and store messages). */
export function displayName(env: Env = process.env): string {
  return resolveDisplayName({ env }).displayName
}

/** The name in text CLAUDE reads (hints, notices, the wake prompt): the display name, or "the user" when it is only the default "You". */
export function nameForAgent(id: UserIdentity = resolveDisplayName()): string {
  return id.source === 'default' ? 'the user' : id.displayName
}
