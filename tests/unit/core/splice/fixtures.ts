// tests/unit/core/splice/fixtures.ts (P1). The committed synthetic docs (tests/fixtures/docs/*.md), decoded the way the
// docstore decodes (§3.1: fatal UTF-8, BOM stripped; load() never sees a BOM, S2-a), for the P1 unit suites.
// The real corpus is the corpus runner's job (tests/corpus/run.ts), never a unit test's.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'docs')

function decode(raw: Buffer): string {
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  return new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(bom ? 3 : 0))
}

/** name → BOM-stripped text, in name order. */
export const FIXTURE_DOCS: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(DIR)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => [n, decode(readFileSync(join(DIR, n)))]),
)

export function fixture(name: string): string {
  const t = FIXTURE_DOCS[name]
  if (t === undefined) throw new Error(`no fixture ${name}`)
  return t
}
