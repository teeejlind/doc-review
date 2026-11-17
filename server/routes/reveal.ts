// server/routes/reveal.ts (onboarding). "Where's my file": the file strip's Reveal button.
//   POST /api/reveal { file } → { ok: true, file }: shows the document in the OS file manager (Finder, Explorer, the
//   Linux desktop's file manager). A browser write like any other (actor TJ): the §8.1 middleware has checked the token,
//   the Origin and X-MDR-Client-Id. `file` is validated by resolveFile (POSIX-relative, inside the root, .md/.markdown,
//   not protected, existing), so the route never opens an arbitrary path.
// The OS command runs without a shell, detached, output ignored: macOS `open -R <abs>`, Windows
// `explorer.exe /select,"<abs>"` (explorer exits 1 even when it worked, so the exit code is never read), elsewhere
// `xdg-open <folder>` (no portable "select this file" there).
// Under test hooks the route never spawns: each request is recorded instead and GET /__test/reveals lists them, so e2e
// and unit tests can assert the click without a Finder window opening.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { StoreError } from '../../shared/errors'
import type { ServerEnv } from '../security'
import { bodyOf, resolveFile, type RouteCtx } from './context'

/** Shows an absolute file path in the OS file manager. Resolves once the command started; rejects if it could not. */
export type RevealFn = (abs: string) => Promise<void>

export interface RevealCommand {
  cmd: string
  args: string[]
  /** Windows: pass `args` to the program as written (explorer wants `/select,"C:\path"`, not Node's quoting). */
  verbatim?: boolean
}

/** The command that reveals `abs` on `platform`. */
export function revealCommand(platform: NodeJS.Platform, abs: string): RevealCommand {
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', abs] }
  // a validated Windows path can't contain a double quote (it is not a legal filename character there)
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,"${abs}"`], verbatim: true }
  return { cmd: 'xdg-open', args: [dirname(abs)] }
}

/** The real reveal: spawn the platform's command, detached, no shell, never waited on past its start. */
export function spawnReveal(abs: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const c = revealCommand(platform, abs)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false, ...(c.verbatim ? { windowsVerbatimArguments: true } : {}) })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    child.once('error', (e) => reject(e))
    child.once('spawn', () => resolve())
    child.unref()
  })
}

export interface RevealRouteOptions {
  /** Under test hooks: record instead of spawning, and mount GET /__test/reveals. */
  testHooks: boolean
  /** Replaces the reveal (unit tests). */
  reveal?: RevealFn
}

export function revealRoutes(ctx: RouteCtx, o: RevealRouteOptions): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>()
  const recorded: Array<{ file: string; abs: string; at: string }> = []
  const reveal: RevealFn = o.reveal ?? (o.testHooks ? async () => undefined : (abs) => spawnReveal(abs))

  app.post('/api/reveal', async (c) => {
    const b = bodyOf(c) as { file?: unknown } | undefined
    const raw = b && typeof b === 'object' && typeof b.file === 'string' ? b.file : c.req.query('file')
    if (raw === undefined) throw new StoreError('BAD_REQUEST', 'missing file')
    const file = resolveFile(ctx.root, raw)
    const abs = join(ctx.root, file)
    try {
      await reveal(abs)
    } catch (e) {
      throw new StoreError('INTERNAL', `could not open the file manager: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (o.testHooks) recorded.push({ file, abs, at: new Date().toISOString() })
    return c.json({ ok: true as const, file })
  })

  if (o.testHooks) app.get('/__test/reveals', (c) => c.json({ ok: true as const, reveals: recorded }))
  return app
}
