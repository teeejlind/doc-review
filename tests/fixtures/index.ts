// tests/fixtures/index.ts (integrator, day 0; CONTRACTS §1 layout, §2.4 item 7).
//
// The committed synthetic fixture docs in tests/fixtures/docs/, with the byte-level facts each one exists to
// exercise. The S2 synthetic set (spike/s2/src/synthetic.ts) is copied verbatim under the same `syn__` names; the rest
// are day-0 additions (the block-HTML fixture of §2.4 item 7, the §12.12 status-header forms, BOM + CRLF, mixed EOLs,
// duplicate quotes, adjacent same-marker lists). `.gitattributes` marks the directory `-text`, and
// tests/unit/shared/fixtures.test.ts asserts every row below against the bytes on disk, so a git or editor rewrite of a
// fixture fails fast. No fixture path contains a protected segment (§9.2), so `npm run dev:server` can serve the dir.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'docs')

export type FixtureFeature =
  | 'basic' | 'crlf' | 'bom' | 'no-final-eol' | 'mixed-eol' | 'trailing-ws' | 'empty' | 'whitespace-only'
  | 'emoji' | 'hard-wrapped' | 'raw-html' | 'block-html' | 'inline-html' | 'tables' | 'frontmatter' | 'toml'
  | 'footnotes' | 'refs' | 'status-header' | 'status-negative' | 'lists' | 'code' | 'blockquote' | 'hr'
  | 'unknown-syntax' | 'tabs' | 'escapes' | 'duplicate-quotes' | 'adjacent-lists'

export interface FixtureDoc {
  file: string
  features: readonly FixtureFeature[]
  bom: boolean
  /** Line endings in the bytes: 'none' = no line break at all. */
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  finalEol: boolean
  bytes: number
  /** For status-header fixtures (§12.12 B): the expected detection rule, or null when nothing may be detected. */
  statusRule?: 'label' | 'phrase' | null
  /** Copied verbatim from the S2 synthetic set. */
  s2?: true
}

const D = (file: string, features: FixtureFeature[], bytes: number, o: Partial<Omit<FixtureDoc, 'file' | 'features' | 'bytes'>> = {}): FixtureDoc =>
  ({ file, features, bytes, bom: false, eol: 'lf', finalEol: true, ...o })

export const FIXTURE_DOCS: readonly FixtureDoc[] = [
  D('basic.md', ['basic', 'lists', 'blockquote'], 287),
  D('syn__block-html.md', ['raw-html', 'block-html', 'inline-html'], 338),
  D('syn__blockquotes.md', ['blockquote', 'lists', 'code'], 168, { s2: true }),
  D('syn__bom-crlf.md', ['bom', 'crlf', 'frontmatter'], 94, { bom: true, eol: 'crlf' }),
  D('syn__bom.md', ['bom'], 33, { bom: true, s2: true }),
  D('syn__code-blocks.md', ['code', 'trailing-ws'], 229, { s2: true }),
  D('syn__crlf-mixed.md', ['mixed-eol', 'crlf'], 103, { eol: 'mixed' }),
  D('syn__crlf-no-final-eol.md', ['crlf', 'no-final-eol'], 40, { eol: 'crlf', finalEol: false, s2: true }),
  D('syn__crlf.md', ['crlf', 'frontmatter', 'tables', 'lists', 'blockquote', 'hard-wrapped'], 235, { eol: 'crlf', s2: true }),
  D('syn__duplicate-quotes.md', ['duplicate-quotes'], 170),
  D('syn__emoji-crlf-no-eol.md', ['emoji', 'crlf', 'no-final-eol'], 51, { eol: 'crlf', finalEol: false }),
  D('syn__emoji.md', ['emoji', 'lists'], 303),
  D('syn__empty.md', ['empty'], 0, { eol: 'none', finalEol: false, s2: true }),
  D('syn__escapes-entities-unicode.md', ['escapes', 'emoji'], 380, { s2: true }),
  D('syn__footnotes.md', ['footnotes'], 227),
  D('syn__frontmatter-complex.md', ['frontmatter', 'status-header'], 274, { s2: true, statusRule: 'label' }),
  D('syn__frontmatter-only.md', ['frontmatter'], 32, { s2: true }),
  D('syn__frontmatter-toml.md', ['frontmatter', 'toml'], 82),
  D('syn__frontmatter.md', ['frontmatter'], 97),
  D('syn__hard-wrapped.md', ['hard-wrapped', 'trailing-ws'], 313, { s2: true }),
  D('syn__html-blocks.md', ['raw-html', 'block-html', 'inline-html'], 302, { s2: true }),
  D('syn__lists-adjacent.md', ['lists', 'adjacent-lists'], 223),
  D('syn__mixed-bullets.md', ['lists'], 295, { s2: true }),
  D('syn__no-trailing-newline.md', ['no-final-eol'], 39, { finalEol: false, s2: true }),
  D('syn__refs-footnotes.md', ['refs', 'footnotes'], 399, { s2: true }),
  D('syn__setext-hr-atx.md', ['hr'], 124, { s2: true }),
  D('syn__status-backtick.md', ['status-header'], 116, { statusRule: 'label' }),
  D('syn__status-beyond-window.md', ['status-negative'], 127, { statusRule: null }),
  D('syn__status-blockquote.md', ['status-header', 'blockquote'], 93, { statusRule: 'label' }),
  D('syn__status-header.md', ['status-header', 'hr'], 224, { s2: true, statusRule: 'label' }),
  D('syn__status-in-heading.md', ['status-negative'], 87, { statusRule: null }),
  D('syn__status-plain.md', ['status-header'], 85, { statusRule: 'label' }),
  D('syn__status-version-line.md', ['status-header'], 125, { statusRule: 'phrase' }),
  D('syn__tables-edge.md', ['tables', 'emoji'], 232, { s2: true }),
  D('syn__tables.md', ['tables'], 192),
  D('syn__tabs.md', ['tabs'], 78, { s2: true }),
  D('syn__trailing-whitespace.md', ['trailing-ws'], 124, { s2: true }),
  D('syn__unknown-syntax.md', ['unknown-syntax'], 193, { s2: true }),
  D('syn__whitespace-only.md', ['whitespace-only'], 6, { s2: true }),
]

/** The block-HTML fixture of §2.4 item 7: a `<div>` block, an HTML comment, a `<details>` pair and inline `<span>`s. */
export const BLOCK_HTML_FIXTURE = 'syn__block-html.md'
/** The default document the shared Playwright fixtures open (tests/e2e/fixtures.ts). */
export const DEFAULT_DOC = 'basic.md'

export function fixturePath(file: string): string {
  return join(FIXTURES_DIR, file)
}
export function fixtureBytes(file: string): Buffer {
  return readFileSync(fixturePath(file))
}
/** Decoded text with the BOM stripped (what `DocSnapshot.markdown` holds). */
export function fixtureText(file: string): string {
  const b = fixtureBytes(file)
  const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  return b.subarray(bom ? 3 : 0).toString('utf8')
}
export function fixturesWith(feature: FixtureFeature): FixtureDoc[] {
  return FIXTURE_DOCS.filter((d) => d.features.includes(feature))
}
