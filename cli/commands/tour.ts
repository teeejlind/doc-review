// cli/commands/tour.ts (onboarding, 2026-11-16). `mdr tour [--dir F] [--launch]`: the 2-minute tour.
//
//   1. picks the folder: --dir, else <home>/Documents/doc-review tutorial. Never the home folder itself or `/`: those
//      are never served (node/root.ts), so the page could not open.
//   2. writes node/tour.ts's practice doc there as "Welcome to doc-review.md". A copy that already has a review
//      (a sidecar, or the file itself) is never overwritten: the new copy gets the next free name ("... 2.md"), so
//      "show me the tour again" always starts clean and nothing the user did is lost.
//   3. posts the six cards as Claude in one batch (through the folder's server when it is up, else directly).
//   4. opens it exactly like `mdr open`, and records tourDone so the tour is never offered again.
// Prints TourResult: OpenResult plus { tour: { folder, cards, threads } } (the cards' thread ids, in document order).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { OpenResult, TourResult } from '../../shared/types'
import { homeOf, writeConfig } from '../../node/config'
import { TOUR_FILE, TOUR_FOLDER, TOUR_MD, TOUR_OPS } from '../../node/tour'
import { locateFile } from '../discover'
import { cliErr, CliExit } from '../output'
import { cliPlatform } from '../waiter-loop'
import { withApply } from './bridge'
import { opt, type Ctx } from './common'
import { runOpen } from './review'

const samePath = (a: string, b: string, win: boolean): boolean => {
  const n = (p: string): string => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return win ? r.toLowerCase() : r
  }
  return n(a) === n(b)
}

/** The first free "Welcome to doc-review[ N].md" in `dir` (free = neither the file nor its review log exists). */
export function freeTourName(dir: string): string {
  const base = TOUR_FILE.replace(/\.md$/, '')
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? TOUR_FILE : `${base} ${i}.md`
    const p = join(dir, name)
    if (!existsSync(p) && !existsSync(`${p}.review.jsonl`)) return name
  }
  throw cliErr('IO_ERROR', `${dir} already holds 999 practice docs; delete some and try again`)
}

/** --dir (relative to the cwd), else <home>/Documents/doc-review tutorial; USAGE for the home folder or `/`. */
export function tourFolder(ctx: Ctx): string {
  const env = ctx.io.env
  const platform = cliPlatform(env)
  const home = homeOf(env, platform)
  const raw = opt(ctx, 'dir')
  const dir = raw !== undefined ? resolve(ctx.io.cwd, raw) : join(home, 'Documents', TOUR_FOLDER)
  const win = platform === 'win32'
  if (samePath(dir, home, win) || samePath(dir, resolve(dir, '/'), win)) {
    throw cliErr('USAGE', `mdr tour: ${dir} can't hold the practice doc (the home folder itself and / are never served); pick a folder inside it`)
  }
  return dir
}

export async function runTour(ctx: Ctx): Promise<CliExit> {
  const dir = tourFolder(ctx)
  let abs: string
  try {
    mkdirSync(dir, { recursive: true })
    abs = join(dir, freeTourName(dir))
    writeFileSync(abs, TOUR_MD, { flag: 'wx' })
  } catch (e) {
    if (e instanceof CliExit) throw e
    throw cliErr('IO_ERROR', `cannot write the practice doc in ${dir}: ${(e as Error).message}`)
  }
  const at = locateFile(abs, ctx.io.cwd)
  const seeded = await withApply(ctx, at, (apply) => apply({ ops: TOUR_OPS }))
  const threads = seeded.results.map((r) => r.thread).filter((t): t is NonNullable<typeof t> => typeof t === 'string')
  const opened = await runOpen({ ...ctx, cmd: { name: 'open', args: [at.abs], opts: { launch: ctx.cmd.opts.launch } } })
  const doc = opened.doc as OpenResult
  try {
    writeConfig({ tourDone: true }, ctx.io.env, cliPlatform(ctx.io.env))
  } catch (e) {
    ctx.verbose(`could not record that the tour ran: ${(e as Error).message}`)
  }
  const out: TourResult = { ...doc, tour: { folder: dir, cards: TOUR_OPS.length, threads } }
  return new CliExit(out, opened.code)
}
