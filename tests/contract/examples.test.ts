// tests/contract/examples.test.ts (integrator, day 0; CONTRACTS §1.3 "Every JSON example in this file is extracted
// and parsed", §4.3 "Example lines (validated by tests/contract/examples.test.ts)", shared/version.ts).
//
// Every ```json / ```jsonl fence in CONTRACTS.md is extracted, parsed, and validated against the schema its section
// names. The EXPECTED table says which schema each fence must satisfy, in order, per section; a fence the table
// doesn't list, or a listed fence that no longer exists, fails the suite, so a new example can't slip in unchecked.
// Plus the checks other frozen files delegate here: MDR_VERSION equals package.json's version (shared/version.ts),
// and the §1.1 package.json block matches the real package.json except where CONTRACT_CHANGES.md records a change.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ID_RE } from '../../shared/ids'
import * as S from '../../shared/schemas'
import { CREATED_BY, MDR_VERSION } from '../../shared/version'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const CONTRACTS = readFileSync(`${REPO}CONTRACTS.md`, 'utf8')
const PKG = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8')) as Record<string, unknown>

interface Fence {
  /** Section number of the nearest preceding heading, e.g. '4.3' or '9.8.1'. */
  section: string
  lang: 'json' | 'jsonl'
  /** 1-based line of the opening fence. */
  line: number
  body: string
}

function extractFences(md: string): Fence[] {
  const lines = md.split('\n')
  const out: Fence[] = []
  let section = '0'
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const h = /^#{2,4}\s+(\d+(?:\.\d+)*)\b/.exec(l) ?? /^#{2,4}\s+Appendix\s+([A-Z])\b/.exec(l)
    if (h) section = h[1]!
    const f = /^```(\w+)\s*$/.exec(l)
    if (!f) continue
    const lang = f[1]!
    let j = i + 1
    while (j < lines.length && !/^```\s*$/.test(lines[j]!)) j++
    if (lang === 'json' || lang === 'jsonl' || lang === 'jsonc' || lang === 'json5') {
      if (lang !== 'json' && lang !== 'jsonl') throw new Error(`CONTRACTS.md:${i + 1}: unsupported fence language ${lang}; use json or jsonl`)
      out.push({ section, lang, line: i + 1, body: lines.slice(i + 1, j).join('\n') })
    }
    i = j
  }
  return out
}

type Check = { name: string; schema: z.ZodType } | { name: 'package.json'; schema: null }
const sc = (name: keyof typeof S): Check => ({ name, schema: S[name] as z.ZodType })

/** Per section, the schema each json fence (or each jsonl line) must satisfy, in document order. */
const EXPECTED: Record<string, Check[]> = {
  '1.1': [{ name: 'package.json', schema: null }],
  '4.1': [sc('SidecarHeaderSchema')],
  '4.3': [sc('SidecarEventSchema')], // jsonl: every line
  '8.2': [sc('ApiErrorSchema')],
  '9.5': [sc('BatchRequestSchema'), sc('BatchRequestSchema'), sc('BatchResultSchema'), sc('CliErrSchema')],
  '9.6': [sc('PendingResultSchema')],
}

const fences = extractFences(CONTRACTS)

function documentsOf(f: Fence): Array<{ line: number; value: unknown }> {
  if (f.lang === 'json') return [{ line: f.line + 1, value: JSON.parse(f.body) as unknown }]
  return f.body
    .split('\n')
    .map((text, k) => ({ text, line: f.line + 1 + k }))
    .filter((x) => x.text.trim() !== '')
    .map((x) => ({ line: x.line, value: JSON.parse(x.text) as unknown }))
}

function issues(schema: z.ZodType, value: unknown): string[] {
  const r = schema.safeParse(value)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}

describe('CONTRACTS.md JSON examples', () => {
  it('finds the fences the table expects, section by section, and nothing else', () => {
    const bySection: Record<string, number> = {}
    for (const f of fences) bySection[f.section] = (bySection[f.section] ?? 0) + 1
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.length]))
    expect(bySection).toEqual(expected)
  })

  it('every fence is valid JSON (jsonl: every line)', () => {
    for (const f of fences) {
      expect(() => documentsOf(f), `CONTRACTS.md:${f.line}`).not.toThrow()
    }
  })

  for (const [section, checks] of Object.entries(EXPECTED)) {
    const inSection = fences.filter((f) => f.section === section)
    checks.forEach((check, k) => {
      const f = inSection[k]
      if (check.schema === null) return
      it(`§${section} example ${k + 1} parses as ${check.name}`, () => {
        expect(f, `no fence #${k + 1} in §${section}`).toBeDefined()
        for (const doc of documentsOf(f!)) {
          expect(issues(check.schema, doc.value), `CONTRACTS.md:${doc.line}`).toEqual([])
        }
      })
    })
  }
})

describe('example semantics the schemas cannot see', () => {
  const docs = (section: string, k = 0) => documentsOf(fences.filter((f) => f.section === section)[k]!).map((d) => d.value)

  it('§4.1 header: createdBy is CREATED_BY (mdr/<MDR_VERSION>)', () => {
    const [header] = docs('4.1') as Array<{ createdBy: string }>
    expect(header!.createdBy).toBe(CREATED_BY)
  })

  it('§4.3 example lines: strictly increasing seq and §4.7 idempotency key formats', () => {
    const lines = docs('4.3') as Array<{ seq: number; type: string; key?: string; clientId?: string; saveId?: number; wal?: { rev: number; hash: string }; rev: number; hash?: string }>
    expect(lines.length).toBeGreaterThanOrEqual(6)
    for (let k = 1; k < lines.length; k++) expect(lines[k]!.seq).toBe(lines[k - 1]!.seq + 1)
    for (const l of lines) {
      if (l.key === undefined) continue
      if (l.key.startsWith('tj:')) expect(l.key.slice(3)).toMatch(ID_RE.opKey)
      else if (l.key.startsWith('cli:')) expect(l.key.slice(4)).toMatch(/^[0-9a-f]{32}$/)
      else if (l.key.startsWith('save:')) {
        expect(l.key).toBe(`save:${l.clientId}:${l.saveId}`)
        expect(l.clientId).toMatch(ID_RE.clientId)
      } else throw new Error(`unknown key format ${l.key}`)
    }
    // a doc.rev WAL line commits its own rev and hash (§4.6)
    for (const l of lines.filter((x) => x.type === 'doc.rev')) {
      expect(l.wal).toEqual({ rev: l.rev, hash: l.hash })
    }
  })

  it('§8.2 STALE_REVISION carries current (every 409 STALE_REVISION / CONFLICT does)', () => {
    const [err] = docs('8.2') as Array<{ error: { code: string; remap?: Record<string, string> }; current?: { rev: number } }>
    expect(err!.error.code).toBe('STALE_REVISION')
    expect(err!.current).toBeDefined()
    for (const [from, to] of Object.entries(err!.error.remap ?? {})) {
      expect(from).toMatch(ID_RE.blockRef)
      expect(to).toMatch(ID_RE.blockRef)
    }
  })

  it('§9.5 batch examples: positional selectors share one rev; the result lists one entry per op, in order', () => {
    const [positional, mixed] = docs('9.5', 0).concat(docs('9.5', 1)) as Array<{ ops: Array<Record<string, unknown>>; ack?: number; ackSince?: number }>
    const revs = new Set(
      positional!.ops.map((o) => (o.target as { rev?: number } | undefined)?.rev).filter((r) => r !== undefined),
    )
    expect(revs.size).toBe(1)
    const [result] = docs('9.5', 2) as Array<{ results: Array<{ i: number; op: string }>; acked: number | null }>
    expect(result!.results.map((r) => r.i)).toEqual(mixed!.ops.map((_, k) => k))
    expect(result!.results.map((r) => r.op)).toEqual(mixed!.ops.map((o) => o.op))
    expect(result!.acked).toBe(mixed!.ack)
  })

  it('§9.5 QUOTE_AMBIGUOUS lists 1-based occurrences in doc order', () => {
    const [err] = docs('9.5', 3) as Array<{ error: { code: string; candidates: Array<{ occurrence: number }> } }>
    expect(err!.error.code).toBe('QUOTE_AMBIGUOUS')
    expect(err!.error.candidates.map((c) => c.occurrence)).toEqual(err!.error.candidates.map((_, k) => k + 1))
  })

  it('§9.6 pending: counts agree with the lists; cursor ≥ since; handoffs inside the window', () => {
    const [p] = docs('9.6') as Array<{
      since: number; cursor: number; empty: boolean
      handoffs: Array<{ seq: number }>; threads: unknown[]; notices: unknown[]
      edits: Array<{ blocks: unknown[] }>; external: Array<{ blocks: unknown[] }>
      counts: { threads: number; handoffs: number; notices: number; edits: number; external: number }
    }>
    expect(p!.cursor).toBeGreaterThanOrEqual(p!.since)
    expect(p!.empty).toBe(false)
    expect(p!.counts.threads).toBe(p!.threads.length)
    expect(p!.counts.handoffs).toBe(p!.handoffs.length)
    expect(p!.counts.notices).toBe(p!.notices.length)
    expect(p!.counts.edits).toBe(p!.edits.reduce((n, e) => n + e.blocks.length, 0))
    expect(p!.counts.external).toBe(p!.external.reduce((n, e) => n + e.blocks.length, 0))
    for (const h of p!.handoffs) {
      expect(h.seq).toBeGreaterThan(p!.since)
      expect(h.seq).toBeLessThanOrEqual(p!.cursor)
    }
  })
})

describe('version and package identity', () => {
  it('MDR_VERSION equals package.json "version" (shared/version.ts)', () => {
    expect(PKG.version).toBe(MDR_VERSION)
  })

  it('the §1.1 package.json block matches package.json (engines excepted: CONTRACT_CHANGES.md D38 row)', () => {
    const block = JSON.parse(fences.find((f) => f.section === '1.1')!.body) as Record<string, unknown>
    for (const key of ['name', 'version', 'type', 'bin', 'scripts', 'dependencies', 'devDependencies']) {
      expect(PKG[key], `package.json "${key}"`).toEqual(block[key])
    }
    // engines differs from §1.1 only by the recorded D38 change; the ledger must say so.
    if (JSON.stringify(PKG.engines) !== JSON.stringify(block.engines)) {
      const ledger = readFileSync(`${REPO}CONTRACT_CHANGES.md`, 'utf8')
      const engines = (PKG.engines as { node: string }).node
      expect(ledger, 'CONTRACT_CHANGES.md must record the engines change').toContain('engines.node')
      expect(ledger.replace(/\\\|/g, '|')).toContain(engines)
    }
  })
})
