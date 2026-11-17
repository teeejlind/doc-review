// tests/unit/cli/tour.test.ts (onboarding, 2026-11-16). The first-run tour: the `tour` config flag, `mdr open
// --offer-tour`, and `mdr tour` (folder choice, never overwriting a used copy, the six cards posted as Claude).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as S from '../../../shared/schemas'
import { tourDone } from '../../../node/config'
import { TOUR_FILE, TOUR_FOLDER, TOUR_MD, TOUR_OPS } from '../../../node/tour'
import { cli, realServer, type RealServer } from './runner'

const dirs: string[] = []
let srv: RealServer | null = null
afterEach(async () => {
  await srv?.stop()
  srv = null
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmpHome = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'mdr-tour-home-')))
  dirs.push(d)
  return d
}
const valid = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } }, v: unknown): void => {
  const r = schema.safeParse(v)
  expect(r.success, JSON.stringify(r.error?.issues?.slice(0, 3))).toBe(true)
}

describe('the tour flag (mdr config ... tour)', () => {
  it('starts as offer; set tour done → done and saved; unset → offer again; bad values are USAGE', async () => {
    const HOME = tmpHome()
    const env = { HOME }
    expect((await cli(['config', 'get'], { env })).json.tour).toBe('offer')
    const a = await cli(['config', 'set', 'tour', 'done'], { env })
    expect(a.code).toBe(0)
    valid(S.ConfigResultSchema, a.json)
    expect(a.json).toMatchObject({ config: { tourDone: true }, tour: 'done' })
    expect(JSON.parse(readFileSync(join(HOME, '.config', 'mdr', 'config.json'), 'utf8'))).toEqual({ tourDone: true })
    expect(tourDone(env, 'darwin')).toBe(true)
    const b = await cli(['config', 'unset', 'tour'], { env })
    expect(b.json).toMatchObject({ config: {}, tour: 'offer' })
    expect((await cli(['config', 'set', 'tour', 'maybe'], { env })).code).toBe(3)
    expect((await cli(['config', 'set', 'tour'], { env })).code).toBe(3)
  })

  it('MDR_TOUR_DONE overrides the file both ways; other keys in the file survive', async () => {
    const HOME = tmpHome()
    await cli(['config', 'set', 'name', 'Ana'], { env: { HOME } })
    await cli(['config', 'set', 'tour', 'done'], { env: { HOME } })
    expect(tourDone({ HOME, MDR_TOUR_DONE: '0' }, 'darwin')).toBe(false)
    expect(tourDone({ HOME: tmpHome(), MDR_TOUR_DONE: '1' }, 'darwin')).toBe(true)
    expect((await cli(['config', 'get'], { env: { HOME } })).json.config).toEqual({ displayName: 'Ana', tourDone: true })
  })

  it('on Windows the flag lives in %APPDATA%\\mdr\\config.json', () => {
    const APPDATA = tmpHome()
    mkdirSync(join(APPDATA, 'mdr'))
    writeFileSync(join(APPDATA, 'mdr', 'config.json'), JSON.stringify({ tourDone: true }))
    expect(tourDone({ APPDATA, USERPROFILE: tmpHome() }, 'win32')).toBe(true)
    expect(tourDone({ APPDATA: tmpHome(), USERPROFILE: tmpHome() }, 'win32')).toBe(false)
  })
})

describe('mdr open --offer-tour', () => {
  it('first-ever review: opens nothing and answers tour: offer; once the tour was offered it is a plain open', async () => {
    const HOME = tmpHome()
    const work = join(HOME, 'work')
    mkdirSync(work)
    const doc = join(work, 'plan.md')
    writeFileSync(doc, '# Plan\n\nHello.\n')
    const a = await cli(['open', doc, '--offer-tour'], { env: { HOME, MDR_USER_NAME: 'Ana' } })
    expect(a.code).toBe(0)
    valid(S.TourOfferResultSchema, a.json)
    expect(a.json).toMatchObject({ tour: 'offer', opened: false, file: 'plan.md', user: { displayName: 'Ana' } })
    expect(existsSync(`${doc}.review.jsonl`)).toBe(false)

    await cli(['config', 'set', 'tour', 'done'], { env: { HOME } })
    srv = await realServer(work)
    const b = await cli(['open', doc, '--offer-tour'], { env: { HOME } })
    expect(b.code).toBe(0)
    valid(S.OpenResultSchema, b.json)
    expect(b.json.url).toContain('?file=plan.md')
  })

  it('--skip-tour (the user said no): records the flag and opens; the tour is never offered again', async () => {
    const HOME = tmpHome()
    const work = join(HOME, 'work')
    mkdirSync(work)
    const doc = join(work, 'plan.md')
    writeFileSync(doc, '# Plan\n')
    srv = await realServer(work)
    const r = await cli(['open', doc, '--skip-tour', '--offer-tour'], { env: { HOME } })
    expect(r.code).toBe(0)
    valid(S.OpenResultSchema, r.json)
    expect(tourDone({ HOME }, 'darwin')).toBe(true)
    expect((await cli(['open', doc, '--offer-tour'], { env: { HOME } })).json.tour).toBeUndefined()
  })
})

describe('mdr tour', () => {
  it('copies the practice doc into ~/Documents/doc-review tutorial, posts the six cards as Claude, opens it, records the flag', async () => {
    const HOME = tmpHome()
    const folder = join(HOME, 'Documents', TOUR_FOLDER)
    mkdirSync(folder, { recursive: true })
    srv = await realServer(folder)
    const r = await cli(['tour'], { env: { HOME } })
    expect(r.code, r.stdout).toBe(0)
    valid(S.TourResultSchema, r.json)
    expect(r.json).toMatchObject({ file: TOUR_FILE, root: folder, tour: { folder, cards: 6 } })
    expect(r.json.tour.threads).toHaveLength(6)
    expect(new Set(r.json.tour.threads).size).toBe(6)
    expect(readFileSync(join(folder, TOUR_FILE), 'utf8')).toBe(TOUR_MD)
    expect(tourDone({ HOME }, 'darwin')).toBe(true)

    const st = await cli(['status', join(folder, TOUR_FILE)], { env: { HOME } })
    expect(st.json.suggestions.pending).toBe(2)
    expect(st.json.threads.detached).toBe(0)
    expect(st.json.threads.open).toBeGreaterThanOrEqual(4)
    const snap = await cli(['pending', join(folder, TOUR_FILE)], { env: { HOME } })
    expect(snap.code).toBe(0)

    // "show me the tour again": a fresh copy beside the used one, nothing overwritten
    const again = await cli(['tour'], { env: { HOME } })
    expect(again.code, again.stdout).toBe(0)
    expect(again.json.file).toBe('Welcome to doc-review 2.md')
    expect(readFileSync(join(folder, TOUR_FILE), 'utf8')).toBe(TOUR_MD)
  })

  it('refuses the home folder itself (it is never served) and /', async () => {
    const HOME = tmpHome()
    for (const dir of [HOME, '/']) {
      const r = await cli(['tour', '--dir', dir], { env: { HOME } })
      expect(r.code).toBe(3)
      expect(r.json.error.message).toMatch(/never served/)
    }
    expect(tourDone({ HOME }, 'darwin')).toBe(false)
  })
})

describe('the practice doc', () => {
  it('every card quote appears exactly once, so each card anchors without --occurrence', () => {
    for (const op of TOUR_OPS) {
      const quote = (op as { quote?: string }).quote
      expect(quote, JSON.stringify(op)).toBeTruthy()
      expect(TOUR_MD.split(quote!).length - 1, quote).toBe(1)
    }
  })

  it('one card per skill: accept, reject, reply, edit, comment, send; nothing company-specific', () => {
    expect(TOUR_OPS.map((o) => o.op)).toEqual(['suggest', 'suggest', 'comment', 'comment', 'comment', 'comment'])
    const all = TOUR_MD + JSON.stringify(TOUR_OPS)
    for (const w of ['Accept', 'Reject', 'reply', 'Editing', 'Comment', 'Send to Claude']) expect(all).toContain(w)
    expect(all).not.toMatch(/TJ\b|investor|borrower/i)
    expect(TOUR_MD.split(/\s+/).length).toBeLessThan(260)
  })
})
