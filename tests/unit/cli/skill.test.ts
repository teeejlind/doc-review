// tests/unit/cli/skill.test.ts (P4; CONTRACTS §9.9, §9.9.1, §9.9.2).
//
// The skill package meets §9.9.2 file by file: SKILL.md (frontmatter, the §9.9 loop verbatim, hard rules, suggest-only
// policy, the 127.0.0.1 URL rule, "tell TJ the URL", ≤ 250 lines), references/cli.md (every command's example parses
// with the real cli/args.ts parser; every ErrorCode with its exit), references/batch-ops.md (every example validates
// against shared/schemas.ts; every AgentOp variant), references/waiter.md, references/third-party-review.md (its
// batch passes the suggest-only classifier), references/troubleshooting.md (every exit code), the CLAUDE.md snippet,
// and the forbidden strings across all of them.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentOp, BatchRequest, ErrorCode } from '../../../shared/types'
import { ERROR_TABLE } from '../../../shared/constants'
import * as S from '../../../shared/schemas'
import { COMMANDS, parseCommand, splitArgs } from '../../../cli/args'
import { firstBlockedOp } from '../../../cli/policy'
import { buildLoopLine } from '../../../cli/waiter-loop'
import { REPO_ROOT } from '../../helpers/tmpRoot'

const SKILL_DIR = join(REPO_ROOT, 'integrations', 'skill')
const read = (rel: string): string => readFileSync(join(REPO_ROOT, 'integrations', rel), 'utf8')
const SKILL = read('skill/SKILL.md')
const CLI = read('skill/references/cli.md')
const BATCH = read('skill/references/batch-ops.md')
const WAITER = read('skill/references/waiter.md')
const THIRD = read('skill/references/third-party-review.md')
const TROUBLE = read('skill/references/troubleshooting.md')
const BRIDGES = read('skill/references/google-docs-and-word.md')
const SNIPPET = read('claude-md-snippet.md')

/** The §9.9 loop block, extracted from the frozen contract. */
function contractLoop(): string {
  const c = readFileSync(join(REPO_ROOT, 'CONTRACTS.md'), 'utf8')
  const at = c.indexOf('### 9.9 Skill loop')
  const open = c.indexOf('```\n', at)
  const close = c.indexOf('\n```', open + 4)
  return c.slice(open + 4, close)
}

/**
 * The paragraph or bullet that documents the stored actor id (QA3: the wire literal for the human is `TJ` whatever
 * their name), as a set of line indexes.
 */
const ACTOR_ID_NOTE = /stored actor id/i
function actorNoteLines(text: string): number[] {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => ACTOR_ID_NOTE.test(l))
  if (at < 0) return []
  let a = at
  while (a > 0 && !lines[a]!.startsWith('- ') && lines[a - 1]!.trim() !== '') a--
  let b = at
  while (b + 1 < lines.length && lines[b + 1]!.trim() !== '' && !lines[b + 1]!.startsWith('- ')) b++
  return Array.from({ length: b - a + 1 }, (_, i) => a + i)
}

const jsonBlocks = (md: string): string[] => [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!)

const issues = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } }, v: unknown): string =>
  JSON.stringify(schema.safeParse(v).error?.issues?.slice(0, 2) ?? [])

describe('SKILL.md (§9.9.2)', () => {
  it('frontmatter: name doc-review and a description that triggers on review / mark up / comment on / redline / give notes on a .md', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)
    expect(fm).not.toBeNull()
    expect(fm![1]).toMatch(/^name: doc-review$/m)
    const desc = fm![1]!.slice(fm![1]!.indexOf('description:')).replace(/\s+/g, ' ')
    for (const t of ['review', 'mark up', 'comment on', 'redline', 'give notes on', '.md', 'either direction']) expect(desc, t).toContain(t)
  })

  it('carries the §9.9 loop verbatim, including its hard rules', () => {
    const loop = contractLoop()
    expect(loop.split('\n').length).toBeGreaterThan(30)
    expect(SKILL).toContain('```\n' + loop + '\n```')
    expect(loop).toContain('Hard rules:')
    expect(loop).toContain('wrap_up blocked:true')
    expect(loop).toContain('No background Agent, Workflow or Monitor task may still be running')
  })

  it('doc-review vs human-review, the suggest-only policy, the 127.0.0.1 URL rule and "tell the user the URL you served on"', () => {
    expect(SKILL).toMatch(/## doc-review or human-review/)
    expect(SKILL).toMatch(/Any `\.md`, in either direction → \*\*doc-review\*\*/)
    expect(SKILL).toMatch(/human-review/)
    for (const t of ['--suggest-only', 'SUGGEST_ONLY', '--allow-edits', 'replace_block', 'decide` with `reject`', 'summary in chat']) expect(SKILL, t).toContain(t)
    expect(SKILL).toContain('http://127.0.0.1:<port>/?file=<rel>')
    expect(SKILL).toMatch(/tell the user the URL you served on/i)
    expect(SKILL.split('\n').length).toBeLessThanOrEqual(250)
  })

  it('generalization pass: no user is named; the display name, --launch and configurable protected folders are explained', () => {
    for (const [name, text] of [['SKILL.md', SKILL], ['cli.md', CLI], ['batch-ops.md', BATCH], ['waiter.md', WAITER], ['third-party-review.md', THIRD], ['troubleshooting.md', TROUBLE]]) {
      // the one place that must spell the wire literal: the note on the stored actor id (below)
      const skip = new Set(actorNoteLines(text!))
      const named = text!.split('\n').filter((_, i) => !skip.has(i)).join('\n')
      expect(named, name).not.toMatch(/\bTJ\b/)
      expect(named, name).not.toMatch(/\b(he|him|his)\b/i)
    }
    for (const t of ['user.displayName', '--launch', 'MDR_PROTECTED_SEGMENTS', 'mdr config set name', 'waiterReason', 'MDR_CMD']) expect(SKILL, t).toContain(t)
  })

  it('QA3: tells the agent the stored actor id `TJ` is the person in user.displayName, in SKILL.md and in cli.md', () => {
    for (const [name, text] of [['SKILL.md', SKILL], ['cli.md', CLI]] as const) {
      const note = actorNoteLines(text).map((i) => text.split('\n')[i]).join(' ')
      expect(note, name).toMatch(/`TJ`/)
      expect(note, name).toContain('user.displayName')
      for (const t of ['decidedBy', 'history', 'tj-session', '`Claude`', '`external`']) expect(note, `${name}: ${t}`).toContain(t)
    }
  })

  it('names every reference file, and every reference file exists', () => {
    const refs = readdirSync(join(SKILL_DIR, 'references')).sort()
    expect(refs).toEqual(['batch-ops.md', 'cli.md', 'google-docs-and-word.md', 'third-party-review.md', 'troubleshooting.md', 'waiter.md'])
    for (const r of refs) expect(SKILL).toContain(`references/${r}`)
  })
})

describe('references/cli.md', () => {
  const examples = [...CLI.matchAll(/^\| ([a-z-]+)(?: \([a-z]+\))? \| `(mdr [^`]+)` \|/gm)].map((m) => ({ cmd: m[1]!, line: m[2]! }))

  it('has one example per §9.4 command, and every example parses with the real cli/args.ts parser', () => {
    for (const c of COMMANDS) expect(examples.some((e) => e.cmd === c), `example for ${c}`).toBe(true)
    for (const e of examples) {
      const argv = splitArgs(e.line)
      expect(argv[0]).toBe('mdr')
      const parsed = parseCommand(argv.slice(1))
      expect(parsed.name, e.line).toBe(e.cmd)
    }
  })

  it('names each command\'s result type', () => {
    for (const t of ['PortResult', 'ServeResult', 'StopResult', 'OpenResult', 'ArmResult', 'StatusResult', 'AgentSnapshot', 'PendingResult',
      'ThreadDetail', 'BatchResult', 'WaitResult', 'DisarmResult', 'HistoryList', 'VersionShow', 'HistoryDiff', 'DoctorResult']) {
      expect(CLI, t).toContain('`' + t + '`')
    }
  })

  it('the exit-code table lists every ErrorCode with its ERROR_TABLE exit code and an action', () => {
    for (const code of Object.keys(ERROR_TABLE) as ErrorCode[]) {
      const row = new RegExp('^\\| `' + code + '` \\| (\\d+) \\| [^|]+ \\| (.+) \\|$', 'm').exec(CLI)
      expect(row, code).not.toBeNull()
      expect(Number(row![1]), code).toBe(ERROR_TABLE[code].exit)
      expect(row![2]!.trim().length, code).toBeGreaterThan(10)
    }
  })
})

describe('references/batch-ops.md', () => {
  const blocks = jsonBlocks(BATCH).map((b) => JSON.parse(b) as Record<string, unknown>)

  it('every JSON example validates against shared/schemas.ts (an AgentOp, a BatchRequest or a CliErr)', () => {
    expect(blocks.length).toBeGreaterThan(20)
    for (const b of blocks) {
      if ('op' in b) expect(S.AgentOpSchema.safeParse(b).success, issues(S.AgentOpSchema, b)).toBe(true)
      else if ('ops' in b) expect(S.BatchRequestSchema.safeParse(b).success, issues(S.BatchRequestSchema, b)).toBe(true)
      else expect(S.CliErrSchema.safeParse(b).success, issues(S.CliErrSchema, b)).toBe(true)
    }
  })

  it('has one example per AgentOp variant, a BatchRequest with ack/ackSince, and the §9.5 base-map example', () => {
    const ops = blocks.filter((b) => 'op' in b) as AgentOp[]
    const names = new Set(ops.map((o) => o.op))
    for (const n of ['comment', 'reply', 'suggest', 'suggest_block', 'replace_block', 'replace_range', 'insert_after', 'insert_before', 'delete_block',
      'write', 'resolve', 'reopen', 'edit_comment', 'delete_comment', 'withdraw', 'decide']) expect(names.has(n as AgentOp['op']), n).toBe(true)
    const comments = ops.filter((o) => o.op === 'comment')
    expect(comments.some((o) => 'quote' in o)).toBe(true)
    expect(comments.some((o) => 'doc' in o)).toBe(true)
    expect(comments.some((o) => 'block' in o)).toBe(true)
    const reqs = blocks.filter((b) => 'ops' in b) as unknown as BatchRequest[]
    expect(reqs.some((r) => r.ack !== undefined && r.ackSince !== undefined)).toBe(true)
    expect(reqs.some((r) => JSON.stringify(r.ops) === JSON.stringify([
      { op: 'insert_after', target: { ref: 'b3', rev: 42 }, markdown: 'A new paragraph after b3.' },
      { op: 'replace_block', target: { ref: 'b9', rev: 42 }, markdown: 'Rewritten b9.' },
      { op: 'delete_block', target: { ref: 'b4', rev: 42 } },
    ]))).toBe(true)
    expect(BATCH).toContain('BATCH_SELF_CONFLICT')
  })

  it('covers the common recoveries', () => {
    const errs = blocks.filter((b) => b.ok === false) as Array<{ error: { code: string; remap?: unknown; candidates?: unknown; sourceQuote?: unknown } }>
    expect(errs.find((e) => e.error.code === 'STALE_REVISION')?.error.remap).toBeDefined()
    expect(errs.find((e) => e.error.code === 'QUOTE_AMBIGUOUS')?.error.candidates).toBeDefined()
    expect(errs.find((e) => e.error.code === 'QUOTE_NOT_IN_SOURCE')?.error.sourceQuote).toBeDefined()
    expect(errs.some((e) => e.error.code === 'SUGGEST_ONLY')).toBe(true)
    for (const t of ['remap', '--occurrence', '--near bN --base-rev R', 'sourceQuote']) expect(BATCH, t).toContain(t)
  })
})

describe('references/waiter.md', () => {
  it('explains the loop, Bash run_in_background only, nothing else in the background, and each exit on wake', () => {
    for (const t of ['run_in_background', 'Exit 2', 'Exit 11', '8 included', 'wrap_up blocked:true', '| 0 |', '| 10 |', '| 8 |']) expect(WAITER, t).toContain(t)
  })

  it('quotes WaiterSpec.command only as an example of a generated line, in the generated shape', () => {
    const lines = WAITER.split('\n').filter((l) => l.includes('while :; do out=$('))
    expect(lines).toHaveLength(1)
    expect(WAITER.slice(0, WAITER.indexOf(lines[0]!))).toMatch(/example only/i)
    const m = /--waiter (w_[0-9a-f]{16})/.exec(lines[0]!)
    const shaped = buildLoopLine({
      node: '/opt/homebrew/bin/node', cli: '/opt/doc-review/dist/cli.js', abs: '/abs/root/plan.md', root: '/abs/root', waiter: m![1] as `w_${string}`, timeoutS: 3300,
    })
    expect(lines[0]).toBe(shaped)
  })
})

describe('references/third-party-review.md', () => {
  it('states §9.9.1 in full and its worked example batch passes the suggest-only classifier', () => {
    for (const t of ['Who decides', 'an agency', 'a vendor', '--suggest-only', '403 SUGGEST_ONLY', 'this doc is suggest-only: use suggest',
      '--allow-edits', 'Claude may edit directly', 'policy.suggestOnly', 'summary', 'replace_block', 'decide` with `accept`']) expect(THIRD, t).toContain(t)
    const batches = jsonBlocks(THIRD).map((b) => JSON.parse(b) as BatchRequest)
    expect(batches).toHaveLength(1)
    expect(S.BatchRequestSchema.safeParse(batches[0]).success, issues(S.BatchRequestSchema, batches[0])).toBe(true)
    expect(firstBlockedOp(batches[0]!)).toBeNull()
    expect(new Set(batches[0]!.ops.map((o) => o.op))).toEqual(new Set(['comment', 'suggest', 'suggest_block']))
  })
})

describe('references/troubleshooting.md', () => {
  it('has a row for every exit code 1–11 and 130, and the named situations', () => {
    for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 130]) expect(TROUBLE, `exit ${code}`).toMatch(new RegExp(`^\\| ${code} \\|`, 'm'))
    for (const t of ['waiter: null', 'PORT_EXHAUSTED', 'PROTOCOL_MISMATCH', 'mdr serve "<root>" --restart', 'start no new loop until `mdr arm` succeeds',
      'Exit 11 from the loop', 'Read-only states']) expect(TROUBLE, t).toContain(t)
  })
})

describe('claude-md-snippet.md', () => {
  it('carries each item', () => {
    for (const t of ['MDR_PROTECTED_SEGMENTS=approvals,legal/signed,legal/filed,registry', 'MDR_USER_NAME=', 'mdr config get']) expect(SNIPPET, t).toContain(t)
    for (const t of ['`mdr port`', 'window of ten', 'http://127.0.0.1:<port>/?file=<rel>', 'approvals/', 'legal/signed/', 'legal/filed/', 'registry/',
      '`waiter.command`', '`run_in_background: true`', 'nothing else in the', 'suggest-only', '`human-review`', 'doc-review']) expect(SNIPPET, t).toContain(t)
    expect(SNIPPET).toMatch(/^.*--force.*$/m)
    expect(/^.*--force.*$/m.exec(SNIPPET)![0]).toMatch(/\bnever\b/i)
  })
})

describe('forbidden strings (§9.9.2)', () => {
  const files: Array<[string, string]> = [
    ['SKILL.md', SKILL], ['references/cli.md', CLI], ['references/batch-ops.md', BATCH], ['references/waiter.md', WAITER],
    ['references/third-party-review.md', THIRD], ['references/troubleshooting.md', TROUBLE], ['references/google-docs-and-word.md', BRIDGES],
    ['claude-md-snippet.md', SNIPPET],
  ]
  const prohibition = /\b(never|no|not|none|don't|do not|forbidden)\b/i
  const generated = (line: string): boolean => line.includes('while :; do out=$(')

  it('the skill and the snippet are complete: every file under integrations/skill is checked', () => {
    const all = ['SKILL.md', ...readdirSync(join(SKILL_DIR, 'references')).map((f) => `references/${f}`)].sort()
    expect(all).toEqual(files.map(([n]) => n).filter((n) => n !== 'claude-md-snippet.md').sort())
  })

  for (const [name, text] of files) {
    it(`${name}: no mdc, no localhost: URLs, no mod handoff; --force, Monitor and mdr wait only inside a "never" rule`, () => {
      expect(text).not.toContain('mdc ')
      expect(text).not.toMatch(/localhost:/)
      expect(text).not.toMatch(/background watch wakes nobody/i)
      expect(text).not.toContain('$.prompt.submit')
      expect(text).not.toContain('$.process.spawn')
      expect(text).not.toMatch(/\bmods?\b/i)
      expect(text).not.toContain('mdr-waiter')
      for (const line of text.split('\n')) {
        if (line.includes('--force')) expect(line, `${name}: ${line}`).toMatch(prohibition)
        if (line.includes('Monitor')) expect(line, `${name}: ${line}`).toMatch(prohibition)
        if (line.includes('mdr wait') && !generated(line)) expect(line, `${name}: ${line}`).toMatch(prohibition)
        if (/stay on it|in the foreground/i.test(line)) expect(line, `${name}: no foreground or stay-on-it option: ${line}`).toMatch(prohibition)
      }
    })
  }
})
