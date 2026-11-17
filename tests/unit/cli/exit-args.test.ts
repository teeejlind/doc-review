// tests/unit/cli/exit-args.test.ts (P4; CONTRACTS §8.2, §9.1, §9.4, §4.7, §9.9.1).
//
// Exit-code mapping for every ErrorCode (StoreError, HTTP ApiError bodies, the in-process run()), the one-document
// stdout and one-line stderr contract, argv parsing for every command, the op each single-op command stands for
// (with no `key` unless --key is given), and the suggest-only classifier over every AgentOp variant.
import { describe, expect, it } from 'vitest'
import type { AgentOp, ErrorCode } from '../../../shared/types'
import { ERROR_TABLE } from '../../../shared/constants'
import { StoreError } from '../../../shared/errors'
import * as S from '../../../shared/schemas'
import { COMMANDS, parseCommand, splitArgs } from '../../../cli/args'
import { exitCodeFor, EXIT_ACTIONS } from '../../../cli/exit'
import { cliErr, CliExit, failureLine, fromError, fromHttp } from '../../../cli/output'
import { blockedBySuggestOnly, firstBlockedOp } from '../../../cli/policy'
import { checkRequest, requestFor } from '../../../cli/commands/write'
import type { Ctx } from '../../../cli/commands/common'
import { cli } from './runner'

const CODES = Object.keys(ERROR_TABLE) as ErrorCode[]

describe('exit codes (§8.2, ERROR_TABLE)', () => {
  it('every ErrorCode maps to its ERROR_TABLE exit, from a StoreError and from an HTTP ApiError body', () => {
    for (const code of CODES) {
      const want = ERROR_TABLE[code].exit
      expect(exitCodeFor(code)).toBe(want)
      const fromStore = fromError(new StoreError(code, `boom ${code}`, { hint: 'h' }))
      expect(fromStore.code).toBe(want)
      expect(fromStore.doc).toEqual({ ok: false, error: { code, message: `boom ${code}`, hint: 'h' } })
      expect(S.CliErrSchema.safeParse(fromStore.doc).success).toBe(true)
      const http = fromHttp(ERROR_TABLE[code].http || 400, JSON.stringify({ ok: false, error: { code, message: 'x' } }))
      expect(http.code).toBe(want)
      expect(cliErr(code, 'y').code).toBe(want)
    }
  })

  it('the waiter-loop codes: 11 is SERVER_UNREACHABLE only; 8 covers the non-retryable mismatches; 10 the clean stops', () => {
    expect(CODES.filter((c) => ERROR_TABLE[c].exit === 11)).toEqual(['SERVER_UNREACHABLE'])
    expect(exitCodeFor('PROTOCOL_MISMATCH')).toBe(8)
    expect(exitCodeFor('ROOT_MISMATCH')).toBe(8)
    expect(CODES.filter((c) => ERROR_TABLE[c].exit === 10).sort()).toEqual(['DISARMED', 'SERVER_STOPPED', 'WAITER_SUPERSEDED'])
    for (const code of new Set(Object.values(ERROR_TABLE).map((e) => e.exit))) expect(EXIT_ACTIONS[code], `action for exit ${code}`).toBeDefined()
    expect(EXIT_ACTIONS[2]).toBeDefined()
  })

  it('a StoreError with `current` keeps it; anything else is INTERNAL; a non-JSON or odd body is INTERNAL with details.status', () => {
    const snap = { file: 'a.md' } as never
    expect(fromError(new StoreError('STALE_REVISION', 'stale', {}, { current: snap })).doc).toMatchObject({ current: snap })
    expect(fromError(new Error('kaboom'))).toMatchObject({ code: 1, doc: { ok: false, error: { code: 'INTERNAL', message: 'kaboom' } } })
    expect(fromHttp(404, 'not found')).toMatchObject({ code: 1, doc: { error: { code: 'INTERNAL', details: { status: 404 } } } })
    expect(fromHttp(500, JSON.stringify({ ok: false, error: { code: 'NOPE' } }))).toMatchObject({ code: 1, doc: { error: { details: { status: 500 } } } })
    expect(fromHttp(200, JSON.stringify({ ok: true, x: 1 }))).toEqual(new CliExit({ ok: true, x: 1 }, 0))
  })

  it('run(): exactly one stdout document, one stderr line on failure, nothing on stderr on success', async () => {
    const bad = await cli(['frobnicate'])
    expect(bad.code).toBe(3)
    expect(bad.docs).toBe(1)
    expect(bad.json).toMatchObject({ ok: false, error: { code: 'USAGE' } })
    expect(bad.stderr.trim().split('\n')).toHaveLength(1)
    expect(bad.stderr).toMatch(/^mdr: USAGE: unknown command/)
    const none = await cli([])
    expect(none.code).toBe(3)
    const pretty = await cli(['frobnicate', '--pretty'])
    expect(pretty.stdout).toContain('\n  "ok": false')
    expect(failureLine({ ok: true })).toBeNull()
  })
})

describe('argv (§9.4)', () => {
  const ok = (line: string) => parseCommand(splitArgs(line))

  it('every command parses with its flags; global --root/--pretty/--verbose on each', () => {
    expect(ok('port /r')).toEqual({ name: 'port', args: ['/r'], opts: {} })
    expect(ok('serve /r --foreground --port 8301').opts).toEqual({ foreground: true, port: '8301' })
    expect(ok('serve --restart').args).toEqual([])
    expect(ok('open a.md --suggest-only --root /r --pretty').opts).toEqual({ suggestOnly: true, root: '/r', pretty: true })
    expect(ok('arm a.md --allow-edits').opts).toEqual({ allowEdits: true })
    expect(ok('status a.md --wait-waiter 5').opts).toEqual({ waitWaiter: '5' })
    expect(ok('snapshot a.md --md --text --from b2 --to b9').opts).toEqual({ md: true, text: true, from: 'b2', to: 'b9' })
    expect(ok('thread a.md t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7').args).toEqual(['a.md', 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R7'])
    expect(ok('comment a.md --quote "member rate" --near b7 --base-rev 42 --body -').opts).toEqual({ quote: 'member rate', near: 'b7', baseRev: '42', body: '-' })
    expect(ok('edit-block a.md --ref b3 --base-rev 4 --md "- item" --insert-after').opts).toEqual({ ref: 'b3', baseRev: '4', md: '- item', insertAfter: true })
    expect(ok('decide a.md s_01JAC3K9Q2T7V5X8Y0Z1W2E3R9 accept').args).toEqual(['a.md', 's_01JAC3K9Q2T7V5X8Y0Z1W2E3R9', 'accept'])
    expect(ok('wait a.md --root /r --waiter w_0123456789abcdef --timeout 3300 --waiter-gen 7').opts)
      .toEqual({ root: '/r', waiter: 'w_0123456789abcdef', timeout: '3300', waiterGen: '7' })
    expect(ok('history a.md --diff v1..current').opts).toEqual({ diff: 'v1..current' })
    expect(ok('doctor a.md --repair --compact --gc --verbose').opts).toEqual({ repair: true, compact: true, gc: true, verbose: true })
    // generalization pass: open --launch, stop --all, config <action> [key] [value]
    expect(ok('open a.md --launch').opts).toEqual({ launch: true })
    expect(ok('stop --all')).toEqual({ name: 'stop', args: [], opts: { all: true } })
    expect(ok('config get')).toEqual({ name: 'config', args: ['get'], opts: {} })
    expect(ok('config set name "Ana Díaz"').args).toEqual(['set', 'name', 'Ana Díaz'])
    expect(ok('config unset protected').args).toEqual(['unset', 'protected'])
    // onboarding: tour, and open --offer-tour / --skip-tour
    expect(ok('tour')).toEqual({ name: 'tour', args: [], opts: {} })
    expect(ok('tour --dir "/x/y z"').opts).toEqual({ dir: '/x/y z' })
    expect(ok('open a.md --offer-tour --skip-tour').opts).toEqual({ offerTour: true, skipTour: true })
    expect(COMMANDS).toHaveLength(31)
  })

  it('unknown commands, unknown flags, missing and excess arguments are USAGE (exit 3)', () => {
    for (const line of ['nope', 'pending', 'pending a.md b.md', 'pending a.md --frob', 'thread a.md', 'decide a.md s_x']) {
      let err: unknown
      try {
        ok(line)
      } catch (e) {
        err = e
      }
      expect(err, line).toBeInstanceOf(CliExit)
      expect((err as CliExit).code, line).toBe(3)
      expect((err as CliExit).doc).toMatchObject({ error: { code: 'USAGE' } })
    }
  })

  it('splitArgs handles quoting like a POSIX shell for the skill examples', () => {
    expect(splitArgs(`mdr comment "/a b/c.md" --body 'it''s' --quote "say \\"hi\\""`)).toEqual(['mdr', 'comment', '/a b/c.md', '--body', 'its', '--quote', 'say "hi"'])
  })
})

// ------------------------------------------------------------------ the op each command stands for

function ctxFor(line: string, o: { stdin?: string; files?: Record<string, string> } = {}): Ctx {
  return {
    cmd: parseCommand(splitArgs(line)),
    verbose: () => {},
    io: {
      cwd: '/', env: {}, stdout: async () => {}, stderr: () => {}, readStdin: async () => o.stdin ?? '',
      readFile: (p) => {
        if (o.files?.[p] !== undefined) return o.files[p]!
        throw new Error('ENOENT')
      },
      openDocStore: async () => {
        throw new Error('unused')
      },
      startServer: async () => {
        throw new Error('unused')
      },
      self: () => ({ node: 'node', execArgv: [], script: 'cli.js' }), signal: new Promise(() => {}),
    },
  }
}
const T1 = 't_01JAB3K9Q2T7V5X8Y0Z1W2E3R7'
const S1 = 's_01JAC3K9Q2T7V5X8Y0Z1W2E3R9'
const C1 = 'c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8'

describe('single-op commands → BatchRequest (§9.4: sugar for batch)', () => {
  const cases: Array<[string, unknown, { stdin?: string; files?: Record<string, string> }?]> = [
    ['comment a.md --quote "member rate" --body "Is 12% current?"', { ops: [{ op: 'comment', quote: 'member rate', body: 'Is 12% current?' }] }],
    ['comment a.md --quote q --occurrence 2 --body b', { ops: [{ op: 'comment', quote: 'q', occurrence: 2, body: 'b' }] }],
    ['comment a.md --quote q --near b7 --base-rev 42 --body -', { ops: [{ op: 'comment', quote: 'q', near: { ref: 'b7', rev: 42 }, body: 'from stdin' }] }, { stdin: 'from stdin' }],
    ['comment a.md --doc --body-file /b.txt', { ops: [{ op: 'comment', doc: true, body: 'file body' }] }, { files: { '/b.txt': 'file body' } }],
    ['comment a.md --block b3 --base-rev 9 --body x', { ops: [{ op: 'comment', block: { ref: 'b3', rev: 9 }, body: 'x' }] }],
    [`reply a.md ${T1} --body yes`, { ops: [{ op: 'reply', thread: T1, body: 'yes' }] }],
    ['suggest a.md --quote "utilize" --replace "use" --reason "House rule"', { ops: [{ op: 'suggest', quote: 'utilize', replace: 'use', reason: 'House rule' }] }],
    [`suggest a.md --quote q --replace - --thread ${T1} --occurrence 3`, { ops: [{ op: 'suggest', quote: 'q', replace: 'R', thread: T1, occurrence: 3 }] }, { stdin: 'R' }],
    ['suggest a.md --block b4 --base-rev 2 --md "New block."', { ops: [{ op: 'suggest_block', target: { ref: 'b4', rev: 2 }, markdown: 'New block.' }] }],
    ['edit-block a.md --ref b3 --base-rev 4 --md "Rewritten."', { ops: [{ op: 'replace_block', target: { ref: 'b3', rev: 4 }, markdown: 'Rewritten.' }] }],
    ['edit-block a.md --line 12 --base-rev 4 --md x --insert-before', { ops: [{ op: 'insert_before', target: { line: 12, rev: 4 }, markdown: 'x' }] }],
    ['edit-block a.md --quote "We launch" --occurrence 1 --md x --insert-after', { ops: [{ op: 'insert_after', target: { quote: 'We launch', occurrence: 1 }, markdown: 'x' }] }],
    ['edit-block a.md --ref b9 --base-rev 4 --delete', { ops: [{ op: 'delete_block', target: { ref: 'b9', rev: 4 } }] }],
    ['edit-block a.md --from b2 --to b4 --base-rev 7 --md-file /m.md', { ops: [{ op: 'replace_range', from: { ref: 'b2', rev: 7 }, to: { ref: 'b4', rev: 7 }, markdown: 'M' }] }, { files: { '/m.md': 'M' } }],
    ['edit-block a.md --from "quote:Intro" --to line:30 --base-rev 7 --md x', { ops: [{ op: 'replace_range', from: { quote: 'Intro' }, to: { line: 30, rev: 7 }, markdown: 'x' }] }],
    ['write a.md --base-rev 12 --md -', { ops: [{ op: 'write', markdown: '# New\n', baseRev: 12 }] }, { stdin: '# New\n' }],
    [`resolve a.md ${T1}`, { ops: [{ op: 'resolve', thread: T1 }] }],
    [`resolve a.md ${T1} --body Fixed.`, { ops: [{ op: 'resolve', thread: T1, body: 'Fixed.' }] }],
    [`reopen a.md ${T1}`, { ops: [{ op: 'reopen', thread: T1 }] }],
    [`decide a.md ${S1} reject`, { ops: [{ op: 'decide', suggestion: S1, decision: 'reject' }] }],
    [`withdraw a.md ${S1}`, { ops: [{ op: 'withdraw', suggestion: S1 }] }],
    [`edit-comment a.md ${C1} --body better`, { ops: [{ op: 'edit_comment', comment: C1, body: 'better' }] }],
    [`delete-comment a.md ${C1}`, { ops: [{ op: 'delete_comment', comment: C1 }] }],
    ['ack a.md --cursor 118 --since 97', { ops: [], ack: 118, ackSince: 97 }],
    ['ack a.md --cursor 5', { ops: [], ack: 5 }],
  ]

  it('each builds exactly its op, valid against the frozen schema, and carries no key unless --key is given (§4.7)', async () => {
    for (const [line, want, io] of cases) {
      const req = await requestFor(ctxFor(line, io))
      expect(req, line).toEqual(want)
      expect(() => checkRequest(req), line).not.toThrow()
      for (const op of req.ops) expect('key' in op, `${line} sent a key`).toBe(false)
      if (line.startsWith('ack')) continue
      const keyed = await requestFor(ctxFor(`${line} --key my-key-1`, io))
      expect(keyed.ops[0]?.key, `${line} --key`).toBe('my-key-1')
    }
  })

  it('batch reads stdin or --ops-file, keeps keys only as given, and --dry-run sets dryRun', async () => {
    const body = { ops: [{ op: 'comment', doc: true, body: 'x' }], ack: 3, ackSince: 1 }
    expect(await requestFor(ctxFor('batch a.md', { stdin: JSON.stringify(body) }))).toEqual(body)
    expect(await requestFor(ctxFor('batch a.md --ops-file /o.json --dry-run', { files: { '/o.json': JSON.stringify(body) } }))).toEqual({ ...body, dryRun: true })
    await expect(requestFor(ctxFor('batch a.md', { stdin: 'nope' }))).rejects.toMatchObject({ code: 3, doc: { error: { code: 'BAD_REQUEST' } } })
    expect(() => checkRequest({ ops: [{ op: 'comment', doc: true, body: '' }] } as never)).toThrow()
    try {
      checkRequest({ ops: [{ op: 'reply', thread: T1, body: 'ok' }, { op: 'reply', thread: 'bad', body: 'x' }] } as never)
    } catch (e) {
      expect((e as CliExit).doc).toMatchObject({ error: { code: 'BAD_REQUEST', op: 1 } })
    }
  })

  it('contradictory or incomplete flags are USAGE', async () => {
    for (const line of [
      'comment a.md --body x', 'comment a.md --doc --quote q --body x', 'comment a.md --block b3 --body x', 'comment a.md --doc',
      'comment a.md --quote q --occurrence 1 --near b2 --base-rev 1 --body x', 'suggest a.md --quote q', 'suggest a.md --block b1 --md x',
      'edit-block a.md --md x', 'edit-block a.md --ref b1 --md x', 'edit-block a.md --ref b1 --base-rev 1 --delete --md x',
      'edit-block a.md --ref b1 --base-rev 1 --md x --insert-after --insert-before', 'edit-block a.md --from b1 --md x',
      'write a.md --md x', 'decide a.md s_01JAC3K9Q2T7V5X8Y0Z1W2E3R9 maybe', 'reply a.md t_bad --body x', 'ack a.md',
      'comment a.md --doc --body x --body-file /f',
    ]) {
      await expect(requestFor(ctxFor(line)), line).rejects.toMatchObject({ code: 3, doc: { error: { code: 'USAGE' } } })
    }
  })
})

describe('suggest-only classifier (§9.9.1, D39)', () => {
  const quote = { quote: 'x' }
  const variants: Array<[AgentOp, boolean]> = [
    [{ op: 'comment', quote: 'x', body: 'b' }, false],
    [{ op: 'comment', doc: true, body: 'b' }, false],
    [{ op: 'comment', block: { ref: 'b1', rev: 1 }, body: 'b' }, false],
    [{ op: 'reply', thread: T1, body: 'b' }, false],
    [{ op: 'suggest', quote: 'x', replace: 'y' }, false],
    [{ op: 'suggest_block', target: quote, markdown: 'y' }, false],
    [{ op: 'replace_block', target: quote, markdown: 'y' }, true],
    [{ op: 'replace_range', from: quote, to: quote, markdown: 'y' }, true],
    [{ op: 'insert_after', target: quote, markdown: 'y' }, true],
    [{ op: 'insert_before', target: quote, markdown: 'y' }, true],
    [{ op: 'delete_block', target: quote }, true],
    [{ op: 'write', markdown: 'y', baseRev: 1 }, true],
    [{ op: 'resolve', thread: T1 }, false],
    [{ op: 'reopen', thread: T1 }, false],
    [{ op: 'edit_comment', comment: C1, body: 'b' }, false],
    [{ op: 'delete_comment', comment: C1 }, false],
    [{ op: 'withdraw', suggestion: S1 }, false],
    [{ op: 'decide', suggestion: S1, decision: 'accept' }, true],
    [{ op: 'decide', suggestion: S1, decision: 'reject' }, false],
  ]

  it('classifies every AgentOp variant allowed or blocked', () => {
    const covered = new Set(variants.map(([op]) => op.op))
    expect([...covered].sort()).toEqual(['comment', 'decide', 'delete_block', 'delete_comment', 'edit_comment', 'insert_after', 'insert_before', 'reopen',
      'replace_block', 'replace_range', 'reply', 'resolve', 'suggest', 'suggest_block', 'withdraw', 'write'])
    for (const [op, blocked] of variants) expect(blockedBySuggestOnly(op), JSON.stringify(op)).toBe(blocked)
    expect(firstBlockedOp({ ops: variants.filter(([, b]) => !b).map(([op]) => op) })).toBeNull()
    expect(firstBlockedOp({ ops: [variants[0]![0], variants[6]![0]] })).toBe(1)
  })
})
