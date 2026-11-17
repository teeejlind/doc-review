// cli/launch.ts (generalization pass, 2026-10-16). `mdr open --launch`: open the review URL in the system browser for
// a user with no Claude Browser pane (terminal Claude Code). macOS `open <url>`, Windows `cmd /c start "" <url>`,
// elsewhere `xdg-open <url>`; detached, hidden on Windows, never waited on. The URL is mdr's own
// http://127.0.0.1:<port>/?file=<encodeURIComponent(rel)>, so it carries no space, quote, & or other cmd metacharacter.
// Under MDR_TEST_HOOKS=1 with MDR_TEST_LAUNCH_LOG=<file> the command is appended to that file as one JSON line instead
// of run, so tests never open a browser.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export interface BrowserCommand {
  cmd: string
  args: string[]
  /** cmd.exe parses its own command line: pass it as written (start's "" title must stay quoted). */
  verbatim: boolean
}

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  if (platform === 'darwin') return { cmd: 'open', args: [url], verbatim: false }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url], verbatim: true }
  return { cmd: 'xdg-open', args: [url], verbatim: false }
}

export interface LaunchResult {
  launched: boolean
  error?: string
}

/** Start the system browser on `url`. Resolves once the opener spawned (launched) or failed to (not launched). */
export function launchBrowser(url: string, o: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform } = {}): Promise<LaunchResult> {
  const env = o.env ?? process.env
  const c = browserCommand(url, o.platform ?? process.platform)
  if (env.MDR_TEST_HOOKS === '1' && env.MDR_TEST_LAUNCH_LOG) {
    try {
      appendFileSync(env.MDR_TEST_LAUNCH_LOG, JSON.stringify({ url, ...c }) + '\n')
      return Promise.resolve({ launched: true })
    } catch (e) {
      return Promise.resolve({ launched: false, error: (e as Error).message })
    }
  }
  return new Promise((done) => {
    let child
    try {
      child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: c.verbatim })
    } catch (e) {
      done({ launched: false, error: (e as Error).message })
      return
    }
    child.once('error', (e) => done({ launched: false, error: e.message }))
    child.once('spawn', () => {
      child.unref()
      done({ launched: true })
    })
  })
}
