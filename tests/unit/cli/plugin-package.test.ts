// tests/unit/cli/plugin-package.test.ts (packaging; CONTRACT_CHANGES.md, 2026-10-16 "packaging" row).
//
// The Claude Code plugin under plugins/doc-review/ is what users
// install. This suite guards the hand-written half (manifest, skill, references, scripts, lock) and the integrity of the
// generated half (runtime/ against its own BUILD.txt). It does not rebuild anything: `npm run check:plugin` does that.
//
// The generic skill under integrations/skill/ has its own suite (skill.test.ts) that pins the §9.9 loop verbatim; the
// plugin's skill adapts that loop for non-technical users (Cowork guard, first-run setup, the printed mdr path), so here
// it is held to the same invariants instead, and its references to the same schemas and the same ERROR_TABLE.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentOp, BatchRequest, ErrorCode } from '../../../shared/types'
import { ERROR_TABLE } from '../../../shared/constants'
import * as S from '../../../shared/schemas'
import { COMMANDS, parseCommand, splitArgs } from '../../../cli/args'
import { firstBlockedOp } from '../../../cli/policy'
import { buildLoopLine } from '../../../cli/waiter-loop'
import { REPO_ROOT } from '../../helpers/tmpRoot'

const PLUGIN = join(REPO_ROOT, 'plugins', 'doc-review')
const SKILL_DIR = join(PLUGIN, 'skills', 'doc-review')
const rd = (p: string): string => readFileSync(join(PLUGIN, p), 'utf8')
const SKILL = rd('skills/doc-review/SKILL.md')
const BUILD_TXT = rd('runtime/BUILD.txt')
const REFS = Object.fromEntries(
  ['batch-ops', 'cli', 'google-docs-and-word', 'third-party-review', 'troubleshooting', 'waiter'].map((n) => [n, rd(`skills/doc-review/references/${n}.md`)]),
) as Record<'batch-ops' | 'cli' | 'third-party-review' | 'troubleshooting' | 'waiter', string>

/** Every regular file under `dir` (POSIX paths relative to `base`), sorted. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, base))
    else out.push(relative(base, p).split('\\').join('/'))
  }
  return out.sort()
}

const jsonBlocks = (md: string): string[] => [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!)
const issues = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } }, v: unknown): string =>
  JSON.stringify(schema.safeParse(v).error?.issues?.slice(0, 2) ?? [])

describe('plugin layout (what the org marketplace sync accepts)', () => {
  const files = walk(PLUGIN)

  it('has the manifest, the skill, the scripts, the lock and a built runtime', () => {
    for (const f of [
      '.claude-plugin/plugin.json', '.gitattributes', 'README.md', 'skills/doc-review/SKILL.md', 'scripts/ensure-runtime.sh',
      'scripts/ensure-runtime.ps1', 'scripts/runtime.lock', 'runtime/mdr.mjs', 'runtime/web/index.html', 'runtime/BUILD.txt',
      'runtime/THIRD_PARTY_LICENSES.txt',
    ]) expect(files, f).toContain(f)
  })

  it('has no bin/ folder, no package.json, no folder named dist, no node_modules', () => {
    for (const f of files) {
      const segs = f.split('/')
      expect(segs.slice(0, -1), f).not.toContain('bin')
      expect(segs.slice(0, -1), f).not.toContain('dist')
      expect(segs, f).not.toContain('node_modules')
    }
    expect(files).not.toContain('package.json')
  })

  it('plugin.json: name, description, semver version, author', () => {
    const m = JSON.parse(rd('.claude-plugin/plugin.json')) as Record<string, unknown>
    expect(m.name).toBe('doc-review')
    expect(typeof m.description === 'string' && (m.description as string).length > 20).toBe(true)
    expect(String(m.version)).toMatch(/^\d+\.\d+\.\d+([-+].+)?$/)
    expect(m.author).toEqual({ name: 'TJ Lind' })
  })

  it('.gitattributes keeps shell scripts LF, PowerShell CRLF and the runtime byte-exact', () => {
    const ga = rd('.gitattributes')
    expect(ga).toMatch(/^\*\.sh\s+eol=lf$/m)
    expect(ga).toMatch(/^\*\.ps1\s+eol=crlf$/m)
    expect(ga).toMatch(/^runtime\/\*\*\s+-text$/m)
  })

  it('the repo marketplace secret scan has nothing to find: no md/json file matches its patterns, and runtime/ holds no md/json', () => {
    const patterns = [/password["']?\s*[:=]/i, /api_key["']?\s*[:=]/i, /secret["']?\s*[:=]/i, /postgres:\/\/[^$]/i, /AKIA[A-Z0-9]{16}/i]
    for (const f of files.filter((x) => /\.(md|json)$/.test(x))) {
      expect(f.startsWith('runtime/'), `${f}: the scan reads md/json under plugins/, and runtime/ is generated`).toBe(false)
      const text = rd(f)
      for (const p of patterns) expect(text, `${f}: ${p}`).not.toMatch(p)
    }
  })

  it('the scripts are plain ASCII with LF endings in the repo (PowerShell 5.1 misreads UTF-8 without a BOM)', () => {
    for (const f of ['scripts/ensure-runtime.sh', 'scripts/ensure-runtime.ps1', 'scripts/runtime.lock']) {
      const buf = readFileSync(join(PLUGIN, f))
      expect(buf.every((b) => b < 0x80), `${f} is ASCII`).toBe(true)
    }
    expect(rd('scripts/ensure-runtime.sh')).not.toContain('\r')
    expect(rd('scripts/ensure-runtime.sh').startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('names no person, workspace or compliance lane of the author (the plugin is a public package)', () => {
    for (const f of files.filter((x) => /\.(md|json|sh|ps1|lock)$/.test(x) && !x.startsWith('runtime/'))) {
      const text = rd(f)
      expect(text, f).not.toMatch(/\/Users\/[a-z]+\/Documents/)
      expect(text, f).not.toMatch(/\b(he|him|his)\b/i)
    }
  })
})

describe('runtime.lock', () => {
  const lock = rd('scripts/runtime.lock')
  const kv = Object.fromEntries(lock.split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

  it('pins one Node version, its official download folder and a SHA-256 for each of the six platform builds', () => {
    expect(kv.NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(kv.NODE_BASE_URL).toBe(`https://nodejs.org/dist/v${kv.NODE_VERSION}`)
    const keys = ['DARWIN_ARM64', 'DARWIN_X64', 'LINUX_X64', 'LINUX_ARM64', 'WIN_X64', 'WIN_ARM64']
    for (const k of keys) expect(kv[`NODE_SHA256_${k}`], k).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(keys.map((k) => kv[`NODE_SHA256_${k}`])).size, 'six different builds, six different hashes').toBe(6)
    expect(Object.keys(kv).sort()).toEqual(['NODE_BASE_URL', 'NODE_VERSION', ...keys.map((k) => `NODE_SHA256_${k}`)].sort())
  })

  it('the version the docs and the skill quote is the pinned one', () => {
    expect(SKILL).toContain(`"node":"${kv.NODE_VERSION}"`)
    expect(BUILD_TXT).toContain(`Node ${kv.NODE_VERSION}`)
  })
})

describe('runtime/ (generated by npm run build:plugin)', () => {
  const listed = [...BUILD_TXT.matchAll(/^([0-9a-f]{64}) {2}(\S.*)$/gm)].map((m) => ({ sha: m[1]!, file: m[2]! }))

  it('BUILD.txt names the commit, the build command and every file with its sha256, and the hashes match the files', () => {
    expect(BUILD_TXT).toMatch(/^doc-review commit: [0-9a-f]{40}|^doc-review commit: unknown/m)
    expect(BUILD_TXT).toMatch(/^build command: npm run build:plugin$/m)
    expect(listed.length).toBeGreaterThan(5)
    for (const { sha, file } of listed) {
      const have = createHash('sha256').update(readFileSync(join(PLUGIN, 'runtime', file))).digest('hex')
      expect(have, file).toBe(sha)
    }
  })

  it('BUILD.txt lists exactly the files that are there (no stray file, no missing one)', () => {
    const actual = walk(join(PLUGIN, 'runtime')).filter((f) => f !== 'BUILD.txt')
    expect(listed.map((l) => l.file).sort()).toEqual(actual)
  })

  it('mdr.mjs is one self-contained file: it imports only node: builtins and starts with its require shim', () => {
    const text = readFileSync(join(PLUGIN, 'runtime', 'mdr.mjs'), 'utf8')
    expect(text.slice(0, 160)).toContain('__mdrCreateRequire')
    const bare = [...text.matchAll(/(?:^|[;}\n])import\s*(?:[^"'`;]*?from\s*)?["']([^"']+)["']/g)].map((m) => m[1]!).filter((s) => !s.startsWith('node:'))
    expect(bare, 'bare-specifier imports').toEqual([])
    expect(text).not.toContain('xhr-sync-worker.js')
  })

  it('the SPA is there with its entry page and hashed assets', () => {
    expect(existsSync(join(PLUGIN, 'runtime', 'web', 'index.html'))).toBe(true)
    const html = readFileSync(join(PLUGIN, 'runtime', 'web', 'index.html'), 'utf8')
    for (const m of html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)) expect(existsSync(join(PLUGIN, 'runtime', 'web', m[1]!)), m[1]).toBe(true)
  })
})

describe('skills/doc-review/SKILL.md', () => {
  it('frontmatter: name doc-review (the folder name) and a description that starts "Use when" and says what and for whom', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)
    expect(fm).not.toBeNull()
    expect(fm![1]).toMatch(/^name: doc-review$/m)
    const desc = fm![1]!.slice(fm![1]!.indexOf('description:') + 'description:'.length).replace(/^\s*>-?\s*/, '').replace(/\s+/g, ' ').trim()
    expect(desc.startsWith('Use when')).toBe(true)
    for (const t of ['review', 'mark up', 'comment on', 'redline', '.md', 'either direction']) expect(desc, t).toContain(t)
    expect(SKILL_DIR.endsWith('doc-review')).toBe(true)
  })

  it('puts the Cowork guard before anything that runs, and the plain-English first-run notice before the download', () => {
    // after the frontmatter: its allowed-tools names the script without running it
    const body = SKILL.indexOf('\n---\n', 4)
    const guard = SKILL.indexOf('Cowork', body)
    const setup = SKILL.indexOf('ensure-runtime.sh', body)
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(setup)
    const notice = SKILL.indexOf('First-time setup for doc-review')
    expect(notice).toBeGreaterThan(setup)
    for (const t of ['nodejs.org', 'about 55 MB', 'no password or', 'happens once']) expect(SKILL, t).toContain(t)
    expect(SKILL).toMatch(/Tell the user this before you run anything/)
  })

  it('explains that the plugin variables are substituted inline, not shell variables, and tells Claude to use the printed mdr path', () => {
    expect(SKILL).toContain('${CLAUDE_PLUGIN_ROOT}')
    expect(SKILL).toContain('${CLAUDE_PLUGIN_DATA}')
    expect(SKILL).toMatch(/are \*\*not\*\* shell variables/)
    expect(SKILL).toMatch(/The `mdr` value in that JSON is the full path/)
    expect(SKILL).toMatch(/Use the path setup prints/)
  })

  it('carries the whole loop: open, show the page (Browser pane, then --launch), snapshot, batch with ack, arm, waiter, wrap_up, disarm', () => {
    const loop = /## The loop[\s\S]*?```\n([\s\S]*?)\n```/.exec(SKILL)![1]!
    expect(loop.split('\n').length).toBeGreaterThan(30)
    for (const t of [
      'mdr open "<abs>"', '--suggest-only', 'preview_start(url)', 'navigate(url)', '--launch', 'user.displayName', 'mdr snapshot "<abs>" --md',
      'mdr batch "<abs>"', '"ack": <cursor>, "ackSince": <since>', 'mdr arm "<abs>"', 'waiter.command', 'run_in_background = true', 'verbatim',
      'mdr status "<abs>" --wait-waiter 5', 'wrap_up blocked:true', 'mdr pending "<abs>"', 'mdr disarm "<abs>"', 'Hard rules:',
      'No background Agent, Workflow or Monitor task may still be running', 'Never use Edit/Write on the .md while a review is open',
      'Third-party documents: comments and suggestions only', 'Send to Claude gives you a prompt to paste here',
    ]) expect(loop, t).toContain(t)
    // the waiter is Bash run_in_background only
    expect(loop).toMatch(/never `mdr wait` in the foreground/)
    expect(loop).toMatch(/Never under Monitor/)
  })

  it('stays short enough to be read whole, tells the user the URL, uses 127.0.0.1 and never a hostname', () => {
    expect(SKILL.split('\n').length).toBeLessThanOrEqual(260)
    expect(SKILL).toContain('http://127.0.0.1:<port>/?file=<rel>')
    expect(SKILL).toMatch(/Tell the user the URL you served on/)
    expect(SKILL).toMatch(/Never compute ports/)
  })

  it('talks to a non-technical user: display name, plain English, no JSON in chat; suggest-only for third-party documents', () => {
    for (const t of ['user.displayName', 'mdr config set name', 'Plain English', 'They are not technical', '--suggest-only', 'SUGGEST_ONLY', '--allow-edits',
      'summary in chat', 'Not a sign-off']) expect(SKILL, t).toContain(t)
  })

  it('names every reference file once at least, and every reference file exists and is named (as the marketplace validator requires)', () => {
    const refs = readdirSync(join(SKILL_DIR, 'references')).sort()
    expect(refs).toEqual(['batch-ops.md', 'cli.md', 'google-docs-and-word.md', 'third-party-review.md', 'troubleshooting.md', 'waiter.md'])
    for (const r of refs) expect(SKILL).toContain(`references/${r}`)
    for (const m of SKILL.matchAll(/references\/[\w./-]+\.\w+/g)) expect(existsSync(join(SKILL_DIR, m[0])), m[0]).toBe(true)
    // nothing but SKILL.md at the skill's top level
    expect(readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md'))).toEqual(['SKILL.md'])
  })

  it('troubleshooting covers setup failures by exit code, and every mdr exit code', () => {
    const t = REFS.troubleshooting
    for (const code of [2, 3, 4, 5, 6, 7, 10]) expect(t, `setup exit ${code}`).toMatch(new RegExp(`^\\| ${code} \\| [^|]+ \\| `, 'm'))
    for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 130]) expect(t, `exit ${code}`).toMatch(new RegExp(`^\\| ${code} \\|`, 'm'))
    for (const x of ['Setup (`ensure-runtime.sh`) failed', 'PROTOCOL_MISMATCH', 'PROTECTED_ROOT', 'waiter: null', 'Read-only states']) expect(t, x).toContain(x)
  })
})

describe('references (the plugin copies stay true to the code)', () => {
  it('cli.md: one example per command that parses with the real parser, and every ErrorCode with its exit code', () => {
    const examples = [...REFS.cli.matchAll(/^\| ([a-z-]+)(?: \([a-z]+\))? \| `(mdr [^`]+)` \|/gm)].map((m) => ({ cmd: m[1]!, line: m[2]! }))
    for (const c of COMMANDS) expect(examples.some((e) => e.cmd === c), `example for ${c}`).toBe(true)
    for (const e of examples) {
      const argv = splitArgs(e.line)
      expect(parseCommand(argv.slice(1)).name, e.line).toBe(e.cmd)
    }
    for (const code of Object.keys(ERROR_TABLE) as ErrorCode[]) {
      const row = new RegExp('^\\| `' + code + '` \\| (\\d+) \\| [^|]+ \\| (.+) \\|$', 'm').exec(REFS.cli)
      expect(row, code).not.toBeNull()
      expect(Number(row![1]), code).toBe(ERROR_TABLE[code].exit)
    }
    expect(REFS.cli).toMatch(/`MDR_CMD` is always set/)
  })

  it('batch-ops.md: every JSON example validates, one per AgentOp variant', () => {
    const blocks = jsonBlocks(REFS['batch-ops']).map((b) => JSON.parse(b) as Record<string, unknown>)
    expect(blocks.length).toBeGreaterThan(20)
    for (const b of blocks) {
      if ('op' in b) expect(S.AgentOpSchema.safeParse(b).success, issues(S.AgentOpSchema, b)).toBe(true)
      else if ('ops' in b) expect(S.BatchRequestSchema.safeParse(b).success, issues(S.BatchRequestSchema, b)).toBe(true)
      else expect(S.CliErrSchema.safeParse(b).success, issues(S.CliErrSchema, b)).toBe(true)
    }
    const names = new Set((blocks.filter((b) => 'op' in b) as AgentOp[]).map((o) => o.op))
    for (const n of ['comment', 'reply', 'suggest', 'suggest_block', 'replace_block', 'replace_range', 'insert_after', 'insert_before', 'delete_block',
      'write', 'resolve', 'reopen', 'edit_comment', 'delete_comment', 'withdraw', 'decide']) expect(names.has(n as AgentOp['op']), n).toBe(true)
  })

  it('third-party-review.md: the worked batch passes the suggest-only classifier', () => {
    const batches = jsonBlocks(REFS['third-party-review']).map((b) => JSON.parse(b) as BatchRequest)
    expect(batches).toHaveLength(1)
    expect(S.BatchRequestSchema.safeParse(batches[0]).success, issues(S.BatchRequestSchema, batches[0])).toBe(true)
    expect(firstBlockedOp(batches[0]!)).toBeNull()
    expect(new Set(batches[0]!.ops.map((o) => o.op))).toEqual(new Set(['comment', 'suggest', 'suggest_block']))
  })

  it('waiter.md: its example line has exactly the shape the CLI generates, with the installed paths', () => {
    const lines = REFS.waiter.split('\n').filter((l) => l.includes('while :; do out=$('))
    expect(lines).toHaveLength(1)
    expect(REFS.waiter.slice(0, REFS.waiter.indexOf(lines[0]!))).toMatch(/example only/i)
    const m = /--waiter (w_[0-9a-f]{16})/.exec(lines[0]!)
    const shaped = buildLoopLine({
      node: '/Users/ana/.claude/plugins/data/doc-review-doc-review/node/bin/node',
      cli: '/Users/ana/.claude/plugins/data/doc-review-doc-review/app/0.1.0-3f9a1c2d0e4b/mdr.mjs',
      abs: '/abs/root/plan.md',
      root: '/abs/root',
      waiter: m![1] as `w_${string}`,
      timeoutS: 3300,
    })
    expect(lines[0]).toBe(shaped)
  })
})

describe('forbidden strings (the generic skill\'s rules, applied to the plugin copy)', () => {
  const files: Array<[string, string]> = [['SKILL.md', SKILL], ...Object.entries(REFS).map(([n, t]): [string, string] => [`references/${n}.md`, t])]
  const prohibition = /\b(never|no|not|none|don't|do not|forbidden)\b/i
  const generated = (line: string): boolean => line.includes('while :; do out=$(')

  for (const [name, text] of files) {
    it(`${name}: no mdc, no localhost: URLs, no mod handoff; --force, Monitor and mdr wait only inside a "never" rule`, () => {
      expect(text).not.toContain('mdc ')
      expect(text).not.toMatch(/localhost:/)
      expect(text).not.toContain('mdr-waiter')
      expect(text).not.toMatch(/\bmods?\b/i)
      expect(text).not.toMatch(/human-review/)
      for (const line of text.split('\n')) {
        if (line.includes('--force')) expect(line, `${name}: ${line}`).toMatch(prohibition)
        if (line.includes('Monitor')) expect(line, `${name}: ${line}`).toMatch(prohibition)
        if (line.includes('mdr wait') && !generated(line)) expect(line, `${name}: ${line}`).toMatch(prohibition)
        if (/stay on it|in the foreground/i.test(line)) expect(line, `${name}: no foreground or stay-on-it option: ${line}`).toMatch(prohibition)
      }
    })
  }
})
