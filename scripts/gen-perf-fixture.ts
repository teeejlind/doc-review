// scripts/gen-perf-fixture.ts (P3; CONTRACTS §1.3 "perf", §11.7).
//
// Writes the §11.7 perf fixture: a 10k-word markdown doc (YAML frontmatter, a body status header, mixed headings,
// paragraphs, bullet, numbered and task lists, blockquotes, two tables) with 50 threads spread evenly through it:
// 40 comments (TJ replies on every third) and 10 Claude suggestions, written through the DocStore's own agent and
// TJ surfaces, so the sidecar is the §4 format exactly as the server writes it. `npm run perf` runs this before
// tests/e2e/p3-perf.spec.ts; P2's plan-perf unit test can import `perfMarkdown()` / `writePerfFixture()`.
//
//   tsx scripts/gen-perf-fixture.ts [outDir]      (default tests/e2e/.tmp/perf-fixture)
//
// Output: <outDir>/root/perf.md, <outDir>/root/perf.md.review.jsonl and <outDir>/fixture.json (word count, thread
// and suggestion ids, sizes). The doc comes from a fixed seed, so every run writes the same text.
//
// The store is P1's `openDocStore` (node/docstore.ts) once it is implemented; until then (the day-0 stub throws
// "not implemented") the contract fake (tests/fakes/FakeDocStore.ts), which writes the same sidecar format.
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ulid } from 'ulid'
import type { AgentOp, DocStore, OpenDocStore, OpKey, SuggestionId, ThreadId } from '../shared/types'

export const PERF_FILE = 'perf.md'
export const PERF_TARGET_WORDS = 10_000
export const PERF_COMMENTS = 40
export const PERF_SUGGESTIONS = 10
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PERF_DEFAULT_DIR = join(REPO, 'tests', 'e2e', '.tmp', 'perf-fixture')

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOUNS = [
  'roadmap', 'milestone', 'budget', 'backlog', 'workshop', 'outline', 'draft', 'deadline', 'template', 'pipeline',
  'contributor', 'allocation', 'portfolio', 'style guide', 'timeline', 'reserve', 'launch plan', 'pool', 'reader',
  'disclosure', 'memo', 'schedule', 'review', 'committee', 'forecast', 'channel', 'campaign', 'audience', 'segment',
]
const VERBS = [
  'tracks', 'changes', 'frames', 'supports', 'limits', 'explains', 'carries', 'reflects', 'shapes', 'moves', 'tightens',
  'clarifies', 'extends', 'reduces', 'anchors', 'tests', 'needs', 'follows', 'replaces', 'balances',
]
const ADJS = [
  'quarterly', 'senior', 'secured', 'short-term', 'revised', 'current', 'monthly', 'expected', 'final', 'draft', 'clear',
  'narrow', 'broad', 'early', 'late', 'stable', 'measured', 'specific', 'plain', 'shared',
]
const OBJECTS = ['it', 'the plan', 'the numbers', 'the timeline', 'our reading of it']
const CONNECT = ['and', 'but', 'so', 'while', 'because', 'although', 'which means', 'as long as']

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Words in the body (frontmatter excluded). */
export function countWords(md: string): number {
  return md.replace(/^---\n[\s\S]*?\n---\n/, '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
}

export interface PerfDoc {
  markdown: string
  wordCount: number
  /** Unique quotes the comments anchor to, in document order. */
  commentQuotes: string[]
  /** Unique quotes the suggestions replace, in document order, with their replacement. */
  suggestions: Array<{ quote: string; replace: string }>
}

/** The perf doc. Every anchored phrase is unique ("Harbor 17 note" never occurs inside another phrase). */
export function perfMarkdown(seed = 20261015): PerfDoc {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const sentence = (): string => {
    const s = `The ${pick(ADJS)} ${pick(NOUNS)} ${pick(VERBS)} the ${pick(NOUNS)} ${pick(CONNECT)} the ${pick(ADJS)} ${pick(NOUNS)} ${pick(VERBS)} ${pick(OBJECTS)}`
    return s + (r() < 0.25 ? `, at least for the ${pick(ADJS)} ${pick(NOUNS)}.` : '.')
  }
  const paragraph = (n: number): string => Array.from({ length: n }, sentence).join(' ')

  const head: string[] = [
    ['---', 'title: Q4 operations review', 'status: Draft for review', 'owner: Pat Lee', 'tags: [perf, fixture]', 'reviewers: 3', '---'].join('\n'),
    '# Q4 operations review',
    '**Status:** Draft v3 · for review by the operations committee',
    paragraph(4),
  ]

  const body: string[] = []
  let section = 0
  let tables = 0
  while (countWords([...head, ...body].join('\n\n')) < PERF_TARGET_WORDS) {
    section++
    body.push(`## ${section}. ${cap(pick(ADJS))} ${pick(NOUNS)} notes`)
    const parts = 4 + Math.floor(r() * 4)
    for (let p = 0; p < parts; p++) {
      if (p === 2 && section % 3 === 0) body.push(`### ${cap(pick(ADJS))} ${pick(NOUNS)}`)
      const k = r()
      if (k < 0.62) body.push(paragraph(3 + Math.floor(r() * 4)))
      else if (k < 0.76) body.push(Array.from({ length: 3 + Math.floor(r() * 3) }, () => `- ${sentence()}`).join('\n'))
      else if (k < 0.86) body.push(Array.from({ length: 3 + Math.floor(r() * 3) }, (_v, i) => `${i + 1}. ${sentence()}`).join('\n'))
      else if (k < 0.92) body.push(Array.from({ length: 3 }, (_v, i) => `- [${i === 0 ? 'x' : ' '}] ${sentence()}`).join('\n'))
      else body.push(`> ${paragraph(2)}`)
    }
    if ((section === 3 || section === 9) && tables < 2) {
      tables++
      const rows = Array.from({ length: 5 }, (_v, i) => `| ${cap(pick(NOUNS))} ${i + 1} | ${(r() * 100).toFixed(1)} | ${pick(ADJS)} | ${pick(VERBS)} |`)
      body.push(['| Item | Value | State | Note |', '| --- | ---: | :---: | --- |', ...rows].join('\n'))
    }
  }
  if (tables < 2) throw new Error('perf fixture: fewer than two tables (raise the section count)')

  // 50 anchor slots spread evenly through the plain paragraphs: every 5th is a suggestion.
  const paraIdx = body.map((b, i) => (b.startsWith('The ') ? i : -1)).filter((i) => i >= 0)
  const total = PERF_COMMENTS + PERF_SUGGESTIONS
  const commentQuotes: string[] = []
  const suggestions: Array<{ quote: string; replace: string }> = []
  for (let s = 0; s < total; s++) {
    const at = paraIdx[Math.floor(((s + 0.5) * paraIdx.length) / total)]!
    if (s % 5 === 4) {
      const quote = `the Ridge ${s + 1} facility`
      suggestions.push({ quote, replace: `the Ridge ${s + 1} credit facility` })
      body[at] = `${body[at]} We still describe ${quote} the old way here.`
    } else {
      const quote = `Harbor ${s + 1} note`
      commentQuotes.push(quote)
      body[at] = `${body[at]} See the ${quote} for the detail.`
    }
  }
  const markdown = [...head, ...body].join('\n\n') + '\n'
  return { markdown, wordCount: countWords(markdown), commentQuotes, suggestions }
}

export interface PerfFixtureInfo {
  dir: string
  root: string
  file: string
  abs: string
  wordCount: number
  bytes: number
  sidecarBytes: number
  threads: ThreadId[]
  comments: ThreadId[]
  suggestions: SuggestionId[]
  store: 'real' | 'fake'
}

async function openStore(root: string, override?: OpenDocStore): Promise<{ store: DocStore; kind: 'real' | 'fake' }> {
  const opts = { mode: 'direct' as const, lockTimeoutMs: 10_000 }
  if (override) return { store: await override(root, PERF_FILE, opts), kind: 'real' }
  try {
    const { openDocStore } = await import('../node/docstore')
    return { store: await openDocStore(root, PERF_FILE, opts), kind: 'real' }
  } catch (e) {
    // the day-0 stub of node/docstore.ts; the contract fake writes the same sidecar
    if (!/not implemented/i.test(e instanceof Error ? e.message : String(e))) throw e
    const { openFakeDocStore } = await import('../tests/fakes/FakeDocStore')
    return { store: await openFakeDocStore(root, PERF_FILE, opts), kind: 'fake' }
  }
}

const opKey = (): OpKey => `op_${ulid()}`

const COMMENT_BODIES = [
  'Is this still current for Q4?',
  'Can we say this in fewer words?',
  'Source for this?',
  'This reads as a promise. Soften it.',
  'Move this up: it is the point of the section.',
  'Who owns this follow-up?',
  'Does legal need to see this line?',
  'Same point as the paragraph above, I think.',
]
const SUGGEST_REASONS = ['Name the facility the way the term sheet does.', 'Consistency with section 2.', 'Matches the deal brief.']
const TJ_REPLIES = ['Agreed, will fix.', 'Leave it for now; Jordan wants it.', 'Good catch.', 'I checked: it is current.']

export async function writePerfFixture(o: { dir?: string; openDocStore?: OpenDocStore } = {}): Promise<PerfFixtureInfo> {
  const dir = resolve(o.dir ?? PERF_DEFAULT_DIR)
  const rootDir = join(dir, 'root')
  rmSync(rootDir, { recursive: true, force: true })
  mkdirSync(rootDir, { recursive: true })
  const root = realpathSync(rootDir).normalize('NFC')
  const doc = perfMarkdown()
  writeFileSync(join(root, PERF_FILE), doc.markdown)
  const { store, kind } = await openStore(root, o.openDocStore)

  const ops: AgentOp[] = [
    ...doc.commentQuotes.map((quote, i): AgentOp => ({ op: 'comment', quote, body: COMMENT_BODIES[i % COMMENT_BODIES.length]! })),
    ...doc.suggestions.map((s, i): AgentOp => ({ op: 'suggest', quote: s.quote, replace: s.replace, reason: SUGGEST_REASONS[i % SUGGEST_REASONS.length]! })),
  ]
  const res = await store.agent.batch({ ops })
  const results = res.results as Array<{ thread?: ThreadId; suggestion?: SuggestionId }>
  const comments = results.slice(0, doc.commentQuotes.length).flatMap((x) => (x.thread ? [x.thread] : []))
  const suggestions = results.slice(doc.commentQuotes.length).flatMap((x) => (x.suggestion ? [x.suggestion] : []))
  if (comments.length !== PERF_COMMENTS || suggestions.length !== PERF_SUGGESTIONS) {
    throw new Error(`perf fixture: expected ${PERF_COMMENTS} comments and ${PERF_SUGGESTIONS} suggestions, got ${comments.length} and ${suggestions.length}`)
  }
  for (let i = 0; i < comments.length; i += 3) await store.tj.reply(comments[i]!, { opKey: opKey(), body: TJ_REPLIES[(i / 3) % TJ_REPLIES.length]! })
  const review = await store.review()
  const info: PerfFixtureInfo = {
    dir,
    root,
    file: PERF_FILE,
    abs: join(root, PERF_FILE),
    wordCount: doc.wordCount,
    bytes: statSync(join(root, PERF_FILE)).size,
    sidecarBytes: statSync(join(root, `${PERF_FILE}.review.jsonl`)).size,
    threads: review.threads.map((t) => t.id),
    comments,
    suggestions,
    store: kind,
  }
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(info, null, 2) + '\n')
  return info
}

const isMain = ((): boolean => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  } catch {
    return false
  }
})()

if (isMain) {
  writePerfFixture(process.argv[2] ? { dir: process.argv[2] } : {}).then(
    (info) => {
      console.log(JSON.stringify({ ok: true, ...info, threads: info.threads.length, comments: info.comments.length, suggestions: info.suggestions.length }))
      process.exit(0)
    },
    (e: unknown) => {
      console.error('gen-perf-fixture:', e instanceof Error ? (e.stack ?? e.message) : e)
      process.exit(1)
    },
  )
}
