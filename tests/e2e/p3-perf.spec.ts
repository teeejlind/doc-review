// tests/e2e/p3-perf.spec.ts (P3; CONTRACTS §11.7, R7.3, §14 P3 E2E "p3-perf").
//
// The §11.7 budgets on the scripts/gen-perf-fixture.ts doc (10k words, 50 threads): `npm run perf` writes the fixture
// first; the spec writes it itself when it is missing.
//   - Cold open < 1 s: navigation start → the `mdr:ready` mark (set by P3 after P2's mdr:editor-ready and the first
//     complete rail layout). Median of 3 runs, each in a fresh browser context and against a server restarted so the
//     doc has not been opened since start (the server parse is included).
//   - Typing ≤ 16 ms per frame: CDP traces while typing 200 characters at 30 ms intervals (5 Enters) in the middle of
//     the doc with the rail visible; tests/helpers/trace.ts measures them (first 10 keystrokes are warm-up). The
//     script runs twice, each from a clean open: once under §11.7's categories for keydown → frame, once with
//     disabled-by-default-devtools.timeline added for the RunTask slices (current Chromium records none without it,
//     and that category's overhead would inflate the frame figures). The autosave task is reported apart (§11.7's
//     carve-out). The keydown → frame p95 is asserted after the 60 Hz vsync phase, with §11.7's raw p95 recorded
//     beside it (contract-changes/P3.md); the raw max ≤ 33 ms is asserted as written.
//   - Playwright's own trace recorder is off here: it snapshots the DOM in the page on every action.
// Results go to tests/e2e/.tmp/perf.json, the traces to test-results/.
//
// On the fake P2 modules there is no mdr:editor-ready mark and the editor takes no keystrokes. The cold-open run then
// marks mdr:editor-ready itself when the fake editor's content is in the page (so P3's rail half of the budget is
// still measured), and the typing run is skipped; the real numbers come with the real P2.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { PERF_DEFAULT_DIR, PERF_FILE, writePerfFixture } from '../../scripts/gen-perf-fixture'
import { analyzeTyping, mainThreads, parseTrace, percentile, slices, TYPING_BUDGET, typingViolations, type TaskSlice, type TraceEvent } from '../helpers/trace'
import { REPO_ROOT } from '../helpers/tmpRoot'
import { expect, test } from './fixtures'
import { P3_SERVER_KIND, sel } from './fixtures/p3'

// Playwright's own trace recorder snapshots the whole DOM in the page on every action (visitNode / captureSnapshot,
// ~18 ms per keystroke on the 10k-word doc), which lands in the measured main-thread time; perf runs without it.
test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: PERF_FILE, trace: 'off' })
// §11.7's budgets are wall-clock on an uncontended machine. Under `npm run e2e` the other workers (and anything else on
// the machine) share the CPU and can double page-load time with nothing in the app changed, so this file alone gets two
// retries: a real regression fails every attempt, a pass on retry is reported as flaky, and every run records the CPU
// load measured while it ran. `npm run perf` (this file alone) is the evidence run for the QA row.
test.describe.configure({ mode: 'serial', timeout: 180_000, retries: 2 })

/** Fraction of all cores busy between two os.cpus() snapshots. */
type CpuSnap = { idle: number; total: number }
const cpuSnap = (): CpuSnap =>
  cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, total: 0 })
const cpuBusy = (a: CpuSnap, b: CpuSnap): number => (b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100) / 100 : 0)

const RESULTS = join(REPO_ROOT, 'tests', 'e2e', '.tmp', 'perf.json')
const results: Record<string, unknown> = {}

test.beforeAll(async () => {
  if (!existsSync(join(PERF_DEFAULT_DIR, 'root', PERF_FILE))) await writePerfFixture()
})

test.afterAll(() => {
  mkdirSync(join(REPO_ROOT, 'tests', 'e2e', '.tmp'), { recursive: true })
  writeFileSync(RESULTS, JSON.stringify({ at: new Date().toISOString(), serverKind: P3_SERVER_KIND, ...results }, null, 2) + '\n')
})

function placeFixture(root: string): void {
  for (const f of [PERF_FILE, `${PERF_FILE}.review.jsonl`]) copyFileSync(join(PERF_DEFAULT_DIR, 'root', f), join(root, f))
}

/** The fake editor's stand-in for P2's mdr:editor-ready (fake builds only). */
const FAKE_EDITOR_READY = (): void => {
  const mark = (): boolean => {
    const ed = document.querySelector('[data-testid="mdr-editor"]')
    if (!ed || ed.childElementCount === 0) return false
    performance.mark('mdr:editor-ready')
    return true
  }
  const mo = new MutationObserver(() => {
    if (mark()) mo.disconnect()
  })
  document.addEventListener('DOMContentLoaded', () => {
    if (!mark()) mo.observe(document.body, { childList: true, subtree: true })
  })
}

async function coldOpen(browser: Browser, url: string): Promise<{ ready: number; editorReady: number; cards: number }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const page = await ctx.newPage()
    if (P3_SERVER_KIND === 'fake') await page.addInitScript(FAKE_EDITOR_READY)
    await page.goto(url)
    await page.waitForFunction(() => performance.getEntriesByName('mdr:ready', 'mark').length > 0, undefined, { timeout: 20_000 })
    return await page.evaluate(() => ({
      ready: performance.getEntriesByName('mdr:ready', 'mark')[0]!.startTime,
      editorReady: performance.getEntriesByName('mdr:editor-ready', 'mark')[0]?.startTime ?? -1,
      cards: document.querySelectorAll('[data-testid="mdr-card"][data-placed="true"]').length,
    }))
  } finally {
    await ctx.close()
  }
}

test('cold open: median mdr:ready < 1000 ms over 3 fresh runs', async ({ browser, server }) => {
  placeFixture(server.root)
  const runs: Array<{ ready: number; editorReady: number; cards: number; cpuBusyBefore: number }> = []
  for (let i = 0; i < 3; i++) {
    // a restarted server has not opened the doc, so its parse is part of the run
    const s = i === 0 ? server : await server.restart()
    // the machine's load just before the run (our own browser is closed and the server idle), so a slow run says why
    const a = cpuSnap()
    await new Promise((r) => setTimeout(r, 300))
    const cpuBusyBefore = cpuBusy(a, cpuSnap())
    const r = await coldOpen(browser, `http://127.0.0.1:${s.port}/?file=${encodeURIComponent(PERF_FILE)}`)
    runs.push({ ...r, cpuBusyBefore })
  }
  const sorted = runs.map((r) => r.ready).sort((a, b) => a - b)
  const median = sorted[1]!
  results.coldOpen = { runs, medianMs: median, budgetMs: 1000, attempt: test.info().retry }
  for (const r of runs) {
    expect(r.ready).toBeGreaterThanOrEqual(r.editorReady)
    expect(r.cards, 'cards placed when mdr:ready is set').toBeGreaterThan(0)
  }
  expect(median, JSON.stringify(runs)).toBeLessThan(1000)
})

test('typing: no main-thread task over 16 ms; keydown → frame p95 ≤ 16 ms, max ≤ 33 ms', async ({ browser, server }, testInfo) => {
  test.skip(P3_SERVER_KIND === 'fake', 'the fake editor takes no keystrokes; measured with the real P2')
  const text = 'The quick review of this paragraph keeps going. '.repeat(5).slice(0, 195)
  /**
   * §11.7's script once, from a clean open (fresh fixture, restarted server, new context) under a trace with these
   * categories: click into the middle of the doc with the rail visible and the active card on screen, then 200
   * characters at 30 ms intervals including 5 Enters.
   */
  const typed = async (file: string, categories: string[]): Promise<{ events: TraceEvent[]; path: string }> => {
    placeFixture(server.root)
    await server.restart()
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    try {
      const page: Page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${server.port}/?file=${encodeURIComponent(PERF_FILE)}`)
      await page.waitForFunction(() => performance.getEntriesByName('mdr:ready', 'mark').length > 0, undefined, { timeout: 20_000 })
      const hl = page.locator(sel('highlight')).nth(20)
      await hl.scrollIntoViewIfNeeded()
      await hl.click()
      await expect(page.locator(`${sel('card')}[data-active="true"]`)).toHaveCount(1)
      // a person's pause before typing: a keystroke that beats the click's selectionchange is P2's race (it lands on
      // the editor's initial node selection, the frontmatter), not the typing path §11.7 measures
      await page.waitForTimeout(300)
      await page.keyboard.press('End')
      const path = testInfo.outputPath(file)
      await browser.startTracing(page, { path, categories })
      for (let i = 0; i < 200; i++) {
        if (i % 40 === 39) await page.keyboard.press('Enter')
        else await page.keyboard.type(text[i % text.length]!)
        await page.waitForTimeout(30)
      }
      const events = parseTrace(await browser.stopTracing())
      // the last save lands before the page closes
      await page.waitForTimeout(1_500)
      expect(readFileSync(join(server.root, PERF_FILE), 'utf8').startsWith('---\n'), 'the typing landed in the doc body, not over the frontmatter').toBe(true)
      return { events, path }
    } finally {
      await ctx.close()
    }
  }

  // Pass 1, frames: §11.7's categories exactly (devtools.timeline + timeline.frame), for keydown → DrawFrame.
  const frames = await typed('typing-trace.json', ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'])
  const a = analyzeTyping(frames.events, { warmupKeystrokes: 10 })

  // Pass 2, tasks: current Chromium emits RunTask only under disabled-by-default-devtools.timeline, which pass 1 leaves
  // out (so its task list is always empty). That category's own overhead inflates frame times, hence two passes.
  // §11.7 carves the autosave plan out of the typing budget ("never on the keystroke path, so it does not count"):
  // AUTOSAVE_MAX_WAIT_MS fires inside a 6 s run, so the task that sends POST /api/save is reported on its own.
  const tasks = await typed('typing-tasks-trace.json', ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame'])
  const t = mainTasks(tasks.events, 10)
  const longTasks = t.keystroke.filter((x) => x.ms > TYPING_BUDGET.taskMs).sort((x, y) => y.ms - x.ms)

  // keydown → DrawFrame p95 ≤ 16 ms can't be met as measured: a keydown waits for the next 60 Hz BeginFrame (a phase
  // spread evenly over 0–16.7 ms, p95 ≈ 16 ms on its own) before any frame can show it. The p95 is asserted on the
  // latency after that phase (does the keystroke make its first frame?); §11.7's raw figure is recorded beside it, and
  // the raw max ≤ 33 ms is asserted as written. Contract change: contract-changes/P3.md.
  const v = vsyncLatency(frames.events, 10)
  const violations = typingViolations({ ...a, maxTaskMs: 0, longTasks: [], p95KeyToFrameMs: v.p95AfterPhaseMs })
  if (longTasks.length) violations.push(`main-thread task ${longTasks[0]!.ms.toFixed(1)} ms > ${TYPING_BUDGET.taskMs} ms (${longTasks.length} over budget)`)
  results.typing = {
    ...a,
    contractP95KeyToFrameMs: a.p95KeyToFrameMs,
    vsyncPhaseP95Ms: v.p95PhaseMs,
    p95AfterPhaseMs: v.p95AfterPhaseMs,
    maxAfterPhaseMs: v.maxAfterPhaseMs,
    keyToFrameMs: undefined,
    longTasks: longTasks.slice(0, 10),
    maxTaskMs: t.keystroke.reduce((m, x) => Math.max(m, x.ms), 0),
    tasksMeasured: t.keystroke.length,
    autosaveTasks: t.autosave,
    violations,
    trace: frames.path,
    tasksTrace: tasks.path,
  }
  expect(t.keystroke.length, 'the task trace recorded main-thread RunTask slices').toBeGreaterThan(100)
  expect(a.measured, 'measured keydowns').toBeGreaterThan(100)
  expect(v.measured, 'keydowns matched to a BeginFrame and a DrawFrame').toBeGreaterThan(100)
  expect(violations, JSON.stringify({ p95AfterPhase: v.p95AfterPhaseMs, rawP95: a.p95KeyToFrameMs, phaseP95: v.p95PhaseMs, max: a.maxKeyToFrameMs, slowest: longTasks.slice(0, 5), autosave: t.autosave })).toEqual([])
})

/**
 * Per measured keydown: the vsync phase (keydown → the next BeginFrame on the renderer's compositor) and the latency
 * after it (that BeginFrame → the first DrawFrame after the keydown; a keydown drawn before the next BeginFrame counts
 * its whole keydown → DrawFrame time). A keystroke that makes its first frame shows the pipeline time (a few ms); each
 * frame it misses adds 16.7 ms.
 */
function vsyncLatency(events: readonly TraceEvent[], warmup: number): { measured: number; p95PhaseMs: number; p95AfterPhaseMs: number; maxAfterPhaseMs: number } {
  const mains = mainThreads(events)
  const pids = new Set(mains.map((m) => m.pid))
  const isMain = (e: { pid: number; tid: number }): boolean => mains.some((m) => m.pid === e.pid && m.tid === e.tid)
  const keys = slices(events, 'EventDispatch').filter((x) => isMain(x) && (x.args?.data as { type?: string } | undefined)?.type === 'keydown').map((x) => x.ts).slice(warmup)
  const at = (name: string): number[] => events.filter((e) => e.name === name && pids.has(e.pid)).map((e) => e.ts).sort((x, y) => x - y)
  const begins = at('BeginFrame')
  const draws = at('DrawFrame')
  const phase: number[] = []
  const after: number[] = []
  for (const k of keys) {
    const d = draws.find((x) => x >= k)
    const b = begins.find((x) => x >= k)
    if (d === undefined || b === undefined) continue
    phase.push((b - k) / 1000)
    after.push((b <= d ? d - b : d - k) / 1000)
  }
  return { measured: after.length, p95PhaseMs: percentile(phase, 95), p95AfterPhaseMs: percentile(after, 95), maxAfterPhaseMs: after.reduce((m, x) => Math.max(m, x), 0) }
}

/**
 * Main-thread RunTask slices after the first `warmup` keydowns, split into the autosave tasks (those that send
 * POST /api/save) and everything else.
 */
function mainTasks(events: readonly TraceEvent[], warmup: number): { keystroke: TaskSlice[]; autosave: TaskSlice[] } {
  const mains = mainThreads(events)
  const isMain = (e: { pid: number; tid: number }): boolean => mains.some((m) => m.pid === e.pid && m.tid === e.tid)
  const keys = slices(events, 'EventDispatch').filter((x) => isMain(x) && (x.args?.data as { type?: string } | undefined)?.type === 'keydown')
  const start = keys[warmup]?.ts ?? Infinity
  const saves = events.filter((e) => e.name === 'ResourceSendRequest' && isMain(e) && String((e.args?.data as { url?: string } | undefined)?.url ?? '').includes('/api/save')).map((e) => e.ts)
  const keystroke: TaskSlice[] = []
  const autosave: TaskSlice[] = []
  for (const x of slices(events, 'RunTask')) {
    if (!isMain(x) || x.ts < start) continue
    const task: TaskSlice = { ts: x.ts / 1000, ms: x.dur / 1000, pid: x.pid, tid: x.tid, name: 'RunTask' }
    if (saves.some((ts) => ts >= x.ts && ts <= x.ts + x.dur)) autosave.push(task)
    else keystroke.push(task)
  }
  return { keystroke, autosave }
}
