// tests/unit/core/status-header/corpus.ts (P2). The markdown files P2's corpus-wide unit tests read: the synthetic
// fixtures (tests/fixtures/docs, tests/corpus/fixtures/synthetic) and, when present, the gitignored real corpus
// (tests/corpus/fixtures/real). Non-UTF-8 files are skipped (the server opens them read-only, §13 #26).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// a string URL: jsdom's global URL is not node's, and fileURLToPath refuses it
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../')

export const SOURCES = [
  { kind: 'synthetic', dir: join(ROOT, 'tests/fixtures/docs') },
  { kind: 'synthetic', dir: join(ROOT, 'tests/corpus/fixtures/synthetic') },
  { kind: 'real', dir: join(ROOT, 'tests/corpus/fixtures/real') },
] as const

export interface CorpusFile { name: string; kind: 'synthetic' | 'real'; text: string }

export function corpusFiles(): { files: CorpusFile[]; realPresent: boolean } {
  const files: CorpusFile[] = []
  let realPresent = false
  for (const s of SOURCES) {
    if (!existsSync(s.dir)) continue
    for (const name of readdirSync(s.dir).filter((n) => n.endsWith('.md')).sort()) {
      const raw = readFileSync(join(s.dir, name))
      const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(bom ? 3 : 0))
      } catch {
        continue
      }
      files.push({ name, kind: s.kind, text })
      if (s.kind === 'real') realPresent = true
    }
  }
  return { files, realPresent }
}

export function fixtureText(name: string): string {
  return readFileSync(join(ROOT, 'tests/fixtures/docs', name), 'utf8')
}
