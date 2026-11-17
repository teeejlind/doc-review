// tests/helpers/trace.ts (integrator, day 0; CONTRACTS §11.7 "Typing ≤ 16 ms per frame").
//
// Parses a Chromium trace (browser.startTracing with `devtools.timeline` and
// `disabled-by-default-devtools.timeline.frame`) and measures the typing budget:
//   - no `RunTask` slice on a renderer main thread (`CrRendererMain`) longer than 16 ms;
//   - keydown `EventDispatch` → the next `DrawFrame` ≤ 16 ms at p95 and ≤ 33 ms max.
// The first `warmupKeystrokes` keydowns (10 in §11.7) are excluded, and so is every task that started before the first
// measured keydown. The Long Tasks API is deliberately not used (its 50 ms floor can't see a 17 ms frame).
// Timestamps in a trace are microseconds; everything this module returns is milliseconds.

export interface TraceEvent {
  name: string
  cat?: string
  /** 'X' complete (with dur), 'B'/'E' begin/end, 'I'/'i'/'n' instant, 'M' metadata, ... */
  ph: string
  /** µs */
  ts: number
  /** µs, complete events only */
  dur?: number
  pid: number
  tid: number
  args?: Record<string, unknown>
}

export interface ThreadRef { pid: number; tid: number }

export interface TaskSlice { ts: number; ms: number; pid: number; tid: number; name: string }

export interface TypingAnalysis {
  mainThreads: ThreadRef[]
  /** Keydown EventDispatch events found on main threads. */
  keydowns: number
  /** Keydowns measured (after the warm-up). */
  measured: number
  /** Main-thread RunTask slices over the long-task threshold, after the warm-up, slowest first. */
  longTasks: TaskSlice[]
  maxTaskMs: number
  /** Per measured keydown: ms from its dispatch start to the next DrawFrame. */
  keyToFrameMs: number[]
  p95KeyToFrameMs: number
  maxKeyToFrameMs: number
  /** Measured keydowns with no DrawFrame after them. */
  unmatchedKeydowns: number
  frames: number
}

export interface TypingBudget {
  /** No main-thread task longer than this (16 ms). */
  taskMs: number
  /** keydown → frame p95 (16 ms). */
  p95Ms: number
  /** keydown → frame max (33 ms). */
  maxMs: number
}
export const TYPING_BUDGET: TypingBudget = { taskMs: 16, p95Ms: 16, maxMs: 33 }

/** Accepts the JSON text, a Buffer, `{ traceEvents: [...] }` or a bare event array. Unknown shapes throw. */
export function parseTrace(input: string | Uint8Array | object): TraceEvent[] {
  let v: unknown = input
  if (typeof input === 'string') v = JSON.parse(input)
  else if (input instanceof Uint8Array) v = JSON.parse(new TextDecoder().decode(input))
  const arr = Array.isArray(v) ? v : (v as { traceEvents?: unknown }).traceEvents
  if (!Array.isArray(arr)) throw new Error('parseTrace: expected a trace event array or { traceEvents: [...] }')
  const out: TraceEvent[] = []
  for (const e of arr as Array<Record<string, unknown>>) {
    if (!e || typeof e.name !== 'string' || typeof e.ph !== 'string') continue
    out.push({
      name: e.name,
      ph: e.ph,
      ts: typeof e.ts === 'number' ? e.ts : 0,
      pid: typeof e.pid === 'number' ? e.pid : 0,
      tid: typeof e.tid === 'number' ? e.tid : 0,
      ...(typeof e.cat === 'string' ? { cat: e.cat } : {}),
      ...(typeof e.dur === 'number' ? { dur: e.dur } : {}),
      ...(e.args && typeof e.args === 'object' ? { args: e.args as Record<string, unknown> } : {}),
    })
  }
  return out
}

/** Threads named CrRendererMain by `thread_name` metadata. */
export function mainThreads(events: readonly TraceEvent[]): ThreadRef[] {
  const seen = new Map<string, ThreadRef>()
  for (const e of events) {
    if (e.ph !== 'M' || e.name !== 'thread_name') continue
    if ((e.args?.name as string | undefined) === 'CrRendererMain') seen.set(`${e.pid}:${e.tid}`, { pid: e.pid, tid: e.tid })
  }
  return [...seen.values()]
}

/** Complete slices of `name` (ph 'X', or paired 'B'/'E' on one thread). */
export function slices(events: readonly TraceEvent[], name: string): Array<{ ts: number; dur: number; pid: number; tid: number; args?: Record<string, unknown> }> {
  const out: Array<{ ts: number; dur: number; pid: number; tid: number; args?: Record<string, unknown> }> = []
  const open = new Map<string, TraceEvent[]>()
  const sorted = [...events].filter((e) => e.name === name).sort((a, b) => a.ts - b.ts)
  for (const e of sorted) {
    const key = `${e.pid}:${e.tid}`
    if (e.ph === 'X') out.push({ ts: e.ts, dur: e.dur ?? 0, pid: e.pid, tid: e.tid, ...(e.args ? { args: e.args } : {}) })
    else if (e.ph === 'B') {
      const st = open.get(key) ?? []
      st.push(e)
      open.set(key, st)
    } else if (e.ph === 'E') {
      const b = open.get(key)?.pop()
      if (b) out.push({ ts: b.ts, dur: e.ts - b.ts, pid: e.pid, tid: e.tid, ...(b.args ? { args: b.args } : {}) })
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** Nearest-rank percentile (p in 0..100); 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * s.length)
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))]!
}

const keydownOf = (args: Record<string, unknown> | undefined): boolean => {
  const data = args?.data as { type?: unknown } | undefined
  return data?.type === 'keydown'
}

export function analyzeTyping(
  events: readonly TraceEvent[],
  o: { warmupKeystrokes?: number; longTaskMs?: number; frameEvents?: readonly string[] } = {},
): TypingAnalysis {
  const warmup = o.warmupKeystrokes ?? 10
  const longMs = o.longTaskMs ?? TYPING_BUDGET.taskMs
  const frameNames = new Set(o.frameEvents ?? ['DrawFrame'])
  const mains = mainThreads(events)
  const isMain = (e: { pid: number; tid: number }): boolean => mains.some((m) => m.pid === e.pid && m.tid === e.tid)
  const keys = slices(events, 'EventDispatch').filter((s) => isMain(s) && keydownOf(s.args))
  const measuredKeys = keys.slice(warmup)
  const start = measuredKeys[0]?.ts ?? Infinity
  const frames = events.filter((e) => frameNames.has(e.name) && e.ph !== 'M').map((e) => e.ts).sort((a, b) => a - b)
  const tasks = slices(events, 'RunTask').filter((s) => isMain(s) && s.ts >= start)
  const longTasks = tasks
    .map((s) => ({ ts: s.ts / 1000, ms: s.dur / 1000, pid: s.pid, tid: s.tid, name: 'RunTask' }))
    .filter((t) => t.ms > longMs)
    .sort((a, b) => b.ms - a.ms)
  const keyToFrameMs: number[] = []
  let unmatched = 0
  let fi = 0
  for (const k of measuredKeys) {
    while (fi < frames.length && frames[fi]! < k.ts) fi++
    if (fi >= frames.length) {
      unmatched++
      continue
    }
    keyToFrameMs.push((frames[fi]! - k.ts) / 1000)
  }
  return {
    mainThreads: mains,
    keydowns: keys.length,
    measured: measuredKeys.length,
    longTasks,
    maxTaskMs: tasks.reduce((m, t) => Math.max(m, t.dur / 1000), 0),
    keyToFrameMs,
    p95KeyToFrameMs: percentile(keyToFrameMs, 95),
    maxKeyToFrameMs: keyToFrameMs.reduce((m, x) => Math.max(m, x), 0),
    unmatchedKeydowns: unmatched,
    frames: frames.length,
  }
}

/** Human-readable budget violations ([] = within budget). */
export function typingViolations(a: TypingAnalysis, b: TypingBudget = TYPING_BUDGET): string[] {
  const v: string[] = []
  if (a.measured === 0) v.push('no keydown EventDispatch on CrRendererMain after the warm-up (was the trace recorded with devtools.timeline?)')
  if (a.maxTaskMs > b.taskMs) v.push(`main-thread task ${a.maxTaskMs.toFixed(1)} ms > ${b.taskMs} ms (${a.longTasks.length} over budget)`)
  if (a.p95KeyToFrameMs > b.p95Ms) v.push(`keydown→frame p95 ${a.p95KeyToFrameMs.toFixed(1)} ms > ${b.p95Ms} ms`)
  if (a.maxKeyToFrameMs > b.maxMs) v.push(`keydown→frame max ${a.maxKeyToFrameMs.toFixed(1)} ms > ${b.maxMs} ms`)
  if (a.unmatchedKeydowns > 0) v.push(`${a.unmatchedKeydowns} measured keydown(s) never reached a DrawFrame`)
  return v
}
