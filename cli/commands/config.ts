// cli/commands/config.ts (generalization pass, 2026-10-16). `mdr config get | set <key> <value> | unset <key>` over
// node/config.ts's file (~/.config/mdr/config.json, %APPDATA%\mdr\config.json on Windows). Keys:
//   name       → displayName: the human's name in the page and in Claude-facing text (MDR_USER_NAME still wins)
//   protected  → protectedSegments: a comma list of folders mdr refuses to serve (MDR_PROTECTED_SEGMENTS still wins;
//                an empty list means none)
//   tour       → tourDone: `set tour done` once Claude offered the 2-minute tour (taken or declined), so it is never
//                offered again; `unset tour` offers it again on the next review
// Every form prints ConfigResult: the file's path and known keys, plus the name and segments in effect with their source.
import type { ConfigResult } from '../../shared/types'
import { configPath, parseSegments, protectedSegmentsInfo, readConfig, tourDone, writeConfig } from '../../node/config'
import { cleanName, MAX_DISPLAY_NAME_CHARS, resolveDisplayName } from '../../node/identity'
import { cliErr, CliExit } from '../output'
import type { Ctx } from './common'

type Key = 'displayName' | 'protectedSegments' | 'tourDone'

const KEYS: Record<string, Key> = {
  name: 'displayName', displayname: 'displayName', 'display-name': 'displayName',
  protected: 'protectedSegments', protectedsegments: 'protectedSegments', 'protected-segments': 'protectedSegments',
  tour: 'tourDone', tourdone: 'tourDone', 'tour-done': 'tourDone',
}

function keyOf(raw: string | undefined, action: string): Key {
  if (raw === undefined) throw cliErr('USAGE', `mdr config ${action}: missing <key> (name, protected or tour)`)
  const k = KEYS[raw.toLowerCase()]
  if (!k) throw cliErr('USAGE', `mdr config ${action}: unknown key ${JSON.stringify(raw)} (name, protected or tour)`)
  return k
}

function result(ctx: Ctx): ConfigResult {
  const env = ctx.io.env
  const c = readConfig(env)
  const config: ConfigResult['config'] = {}
  if (typeof c.displayName === 'string') config.displayName = c.displayName
  if (Array.isArray(c.protectedSegments)) config.protectedSegments = c.protectedSegments.filter((x): x is string => typeof x === 'string')
  if (typeof c.tourDone === 'boolean') config.tourDone = c.tourDone
  return {
    ok: true, path: configPath(env), config, user: resolveDisplayName({ env }), protectedSegments: protectedSegmentsInfo(env),
    tour: tourDone(env) ? 'done' : 'offer',
  }
}

function write(ctx: Ctx, patch: Partial<Record<Key, unknown>>): void {
  try {
    writeConfig(patch, ctx.io.env)
  } catch (e) {
    throw cliErr('IO_ERROR', `cannot write ${configPath(ctx.io.env)}: ${(e as Error).message}`)
  }
}

export async function runConfig(ctx: Ctx): Promise<CliExit> {
  const [action, rawKey, value, ...extra] = ctx.cmd.args
  if (extra.length) throw cliErr('USAGE', `mdr config: too many arguments (quote a value with spaces: mdr config set name "Ana Díaz")`)
  switch (action) {
    case 'get':
      if (rawKey !== undefined) keyOf(rawKey, 'get')
      return new CliExit(result(ctx), 0)
    case 'set': {
      const key = keyOf(rawKey, 'set')
      if (value === undefined) throw cliErr('USAGE', `mdr config set ${rawKey}: missing <value>`)
      if (key === 'displayName') {
        const name = cleanName(value)
        if (!name) throw cliErr('USAGE', 'mdr config set name: the name is empty (use mdr config unset name to clear it)')
        if (Array.from(value.trim()).length > MAX_DISPLAY_NAME_CHARS) throw cliErr('USAGE', `mdr config set name: at most ${MAX_DISPLAY_NAME_CHARS} characters`)
        write(ctx, { displayName: name })
      } else if (key === 'tourDone') {
        if (!['done', 'true', '1', 'yes'].includes(value.trim().toLowerCase())) throw cliErr('USAGE', 'mdr config set tour: the value is done (mdr config unset tour offers it again)')
        write(ctx, { tourDone: true })
      } else {
        write(ctx, { protectedSegments: parseSegments(value) })
      }
      return new CliExit(result(ctx), 0)
    }
    case 'unset': {
      const key = keyOf(rawKey, 'unset')
      if (value !== undefined) throw cliErr('USAGE', `mdr config unset ${rawKey}: takes no value`)
      write(ctx, { [key]: undefined })
      return new CliExit(result(ctx), 0)
    }
    default:
      throw cliErr('USAGE', `mdr config: unknown action ${JSON.stringify(action)} (get, set or unset)`)
  }
}
