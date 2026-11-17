// tests/helpers/tmpRoot.ts (integrator, day 0; CONTRACTS §1.3 e2e row).
//
// A throwaway served root: a fresh directory under tests/e2e/.tmp/ (gitignored) holding a copy of the committed
// fixture docs, plus a sibling tmp HOME for every spawned `mdr` process, so no test ever touches the real $HOME or a
// real workspace. `root` is realpath + NFC (D23), the same identity the server reports in Health.root.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_DOCS, FIXTURES_DIR } from '../fixtures/index'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const E2E_TMP_DIR = join(REPO_ROOT, 'tests', 'e2e', '.tmp')

export interface TmpRootOptions {
  /** Fixture docs to copy into the root (names from tests/fixtures/docs). Default 'all'. */
  fixtures?: readonly string[] | 'all' | 'none'
  /** Extra files to write, rel path -> content. */
  files?: Record<string, string | Buffer>
  /** Directory-name prefix, e.g. the spec title. */
  name?: string
  /** Parent directory. Default tests/e2e/.tmp. */
  base?: string
}

export interface TmpRoot {
  /** realpath + NFC of the root (what Health.root reports). */
  readonly root: string
  /** A tmp HOME for spawned processes (outside the root, so the protected-root guard never sees it). */
  readonly home: string
  /** Rel paths of the copied fixtures. */
  readonly files: readonly string[]
  /** Absolute path of a root-relative POSIX path. */
  path(rel: string): string
  /** Root-relative POSIX path of an absolute path. */
  rel(abs: string): string
  exists(rel: string): boolean
  /** Raw UTF-8 decode, BOM kept. */
  read(rel: string): string
  readBytes(rel: string): Buffer
  write(rel: string, content: string | Buffer): void
  remove(rel: string): void
  /** `<abs>.review.jsonl` (§3.7). */
  sidecarPath(rel: string): string
  /** Parsed sidecar lines (header first); a torn or corrupt line is returned as `{ __raw: line }`. [] when absent. */
  readSidecar(rel: string): unknown[]
  cleanup(): void
}

const toPosix = (p: string): string => p.split(sep).join('/')

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'root'
}

/** Create a tmp root with fixture copies. Synchronous; the Playwright fixture and vitest both call it directly. */
export function tmpRoot(o: TmpRootOptions = {}): TmpRoot {
  const base = o.base ?? E2E_TMP_DIR
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `${slug(o.name ?? 'root')}-`))
  const rootDir = join(dir, 'root')
  const homeDir = join(dir, 'home')
  mkdirSync(rootDir)
  mkdirSync(homeDir)
  const names = o.fixtures === 'none' ? [] : o.fixtures === undefined || o.fixtures === 'all' ? FIXTURE_DOCS.map((d) => d.file) : [...o.fixtures]
  for (const n of names) cpSync(join(FIXTURES_DIR, n), join(rootDir, n))
  for (const [rel, content] of Object.entries(o.files ?? {})) {
    const abs = join(rootDir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const root = realpathSync.native(rootDir).normalize('NFC')
  const home = realpathSync.native(homeDir).normalize('NFC')
  const path = (rel: string): string => join(root, ...rel.split('/'))
  return {
    root,
    home,
    files: [...names, ...Object.keys(o.files ?? {})],
    path,
    rel: (abs) => toPosix(relative(root, abs)),
    exists: (rel) => existsSync(path(rel)),
    read: (rel) => readFileSync(path(rel), 'utf8'),
    readBytes: (rel) => readFileSync(path(rel)),
    write: (rel, content) => {
      mkdirSync(dirname(path(rel)), { recursive: true })
      writeFileSync(path(rel), content)
    },
    remove: (rel) => rmSync(path(rel), { force: true }),
    sidecarPath: (rel) => path(rel) + '.review.jsonl',
    readSidecar: (rel) => {
      const p = path(rel) + '.review.jsonl'
      if (!existsSync(p)) return []
      return readFileSync(p, 'utf8').split('\n').filter((l) => l !== '').map((l) => {
        try {
          return JSON.parse(l) as unknown
        } catch {
          return { __raw: l }
        }
      })
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
