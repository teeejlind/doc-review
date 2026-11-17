// eslint.config.js (integrator; CONTRACTS §1, §1.1 "Lint and DOM-test tooling", §2.3, §2.4 item 9, D52).
//
// - Parser: @babel/eslint-parser with preset-typescript (+ syntax-jsx for .tsx). typescript-eslint can't run against
//   TypeScript 7 (D52), so lint is syntax-level only; types are `tsc -b`'s job (`npm run typecheck`).
// - Import boundaries (§2.3): eslint-plugin-boundaries over the module layout, resolved through
//   eslint-import-resolver-typescript. Later policies override earlier ones.
// - DAY0-STUB rule (§2.4 item 9): a `// DAY0-STUB (owner: Pn; replaced at <milestone>)` marker left in a file whose
//   milestone has merged fails lint. The integrator adds each milestone to MERGED_MILESTONES in its merge commit.
import babelParser from '@babel/eslint-parser'
import boundaries from 'eslint-plugin-boundaries'

/** Milestones merged to main (CONTRACTS §2.5). Integrator-only; append in the merge commit: 'M1', 'M2', 'M3', 'P2 merge', 'P3 merge'. */
export const MERGED_MILESTONES = ['M1', 'M2', 'M3', 'M4', 'P2 merge', 'P3 merge']

const MARKER_RE = /^\s*DAY0-STUB \(owner: (P[1-4]); replaced at (M[0-4]|P[1-4] merge)\)\s*$/

/** @type {import('eslint').Rule.RuleModule} */
const day0StubRule = {
  meta: {
    type: 'problem',
    docs: { description: 'DAY0-STUB markers must be well-formed and must not survive their milestone (CONTRACTS §2.4 item 9)' },
    schema: [{ type: 'object', properties: { merged: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      merged: 'DAY0-STUB (owner {{owner}}) is past its milestone: {{milestone}} has merged. Replace the stub with the real module.',
      malformed: 'Malformed DAY0-STUB marker. Use exactly "// DAY0-STUB (owner: Pn; replaced at Mx)" (or "replaced at Pn merge").',
    },
  },
  create(context) {
    const merged = new Set((context.options[0] && context.options[0].merged) || MERGED_MILESTONES)
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          // A marker is a line comment that starts with DAY0-STUB; prose that merely mentions it is not one.
          if (c.type !== 'Line' || !/^\s*DAY0-STUB\b/.test(c.value)) continue
          const m = MARKER_RE.exec(c.value)
          if (!m) context.report({ loc: c.loc, messageId: 'malformed' })
          else if (merged.has(m[2])) context.report({ loc: c.loc, messageId: 'merged', data: { owner: m[1], milestone: m[2] } })
        }
      },
    }
  },
}

export const mdrPlugin = { meta: { name: 'mdr' }, rules: { 'day0-stub': day0StubRule } }

const P3_DIRS = '{shell,rail,threads,history,handoff,theme,narrow}'

/** Elements are folders (first match wins, so the specific folders come before their parents); relative to the repo root. */
const ELEMENTS = [
  { type: 'shared', pattern: 'shared/**', partialMatch: false },
  { type: 'core', pattern: 'core/**', partialMatch: false },
  { type: 'node', pattern: 'node/**', partialMatch: false },
  { type: 'server', pattern: 'server/**', partialMatch: false },
  { type: 'cli', pattern: 'cli/**', partialMatch: false },
  { type: 'web-session', pattern: 'web/src/session/**', partialMatch: false },
  { type: 'web-editor', pattern: 'web/src/editor/**', partialMatch: false },
  { type: 'web-p3', pattern: `web/src/${P3_DIRS}/**`, partialMatch: false },
  { type: 'web', pattern: 'web/**', partialMatch: false },
  { type: 'tests', pattern: 'tests/**', partialMatch: false },
  { type: 'scripts', pattern: 'scripts/**', partialMatch: false },
]
/** The individual files §2.3 singles out. */
const FILES = [
  { category: 'dom-env', pattern: 'core/md/dom-env.node.ts' },
  { category: 'server-entry', pattern: 'server/index.ts' },
  { category: 'web-entry', pattern: 'web/src/{main,App}.tsx' },
  { category: 'p2-entry', pattern: 'web/src/{session,editor}/index.ts' },
]

const types = (...t) => ({ types: { anyOf: t } })
const from = (...t) => ({ element: types(...t) })
const to = (...t) => ({ to: { element: types(...t) } })
const P2 = ['web-session', 'web-editor']
const WEB = ['web', 'web-p3', ...P2]
const EDITOR_PACKAGES = ['prosemirror-*', '@milkdown/*', '@handlewithcare/*']
const WEB_ENTRY = { element: { type: 'web' }, file: { categories: 'web-entry' } }

/**
 * §2.3, bullet by bullet. Local imports default to disallowed; packages and builtins are allowed unless a later
 * policy says otherwise (the last matching policy wins).
 */
const POLICIES = [
  { allow: { to: { module: { origin: ['external', 'core'] } } } },
  { from: from('tests', 'scripts'), allow: { to: { element: types(...ELEMENTS.map((e) => e.type)) } } },
  // shared/ imports nothing outside shared/ (zod is the one package, for schemas.ts)
  { from: from('shared'), allow: to('shared') },
  { from: from('shared'), disallow: { to: { module: { origin: ['external', 'core'] } } } },
  { from: from('shared'), allow: { to: { module: { origin: 'external', source: 'zod' } } } },
  // core/ imports shared/ and its own files; no node:* or bare builtins, no jsdom (dom-env.node.ts is the exception)
  { from: from('core'), allow: to('core', 'shared') },
  { from: from('core'), disallow: { to: { module: { origin: 'core' } } } },
  { from: from('core'), disallow: { to: { module: { origin: 'external', source: 'jsdom' } } } },
  { from: { element: { type: 'core' }, file: { categories: 'dom-env' } }, allow: { to: { module: { origin: 'external', source: 'jsdom' } } } },
  // node/ imports core/, shared/, node:*
  { from: from('node'), allow: to('node', 'core', 'shared') },
  // server/ imports node/, core/, shared/
  { from: from('server'), allow: to('server', 'node', 'core', 'shared') },
  // cli/ imports node/, core/, shared/; of server/ only server/index.ts (startServer, for `serve`)
  { from: from('cli'), allow: to('cli', 'node', 'core', 'shared') },
  { from: from('cli'), allow: { to: { element: { type: 'server' }, file: { categories: 'server-entry' } } } },
  // web/ imports core/ and shared/, never node/ or server/, and no node builtins
  { from: from(...WEB), allow: to('web', 'core', 'shared') },
  { from: from(...WEB), disallow: { to: { module: { origin: 'core' } } } },
  // P2 (editor, session) may use each other, never P3 code
  { from: from(...P2), allow: to(...P2) },
  // P3 reaches the editor only through EditorBridge / DocSession: no P2 imports, no prosemirror / milkdown / suggest-changes
  { from: from('web-p3'), allow: to('web-p3') },
  { from: from('web-p3'), disallow: { to: { module: { origin: 'external', source: EDITOR_PACKAGES } } } },
  // main.tsx / App.tsx: P3's shell plus exactly the two P2 entry modules
  { from: WEB_ENTRY, allow: to('web-p3') },
  { from: WEB_ENTRY, allow: { to: { element: types(...P2), file: { categories: 'p2-entry' } } } },
  { from: WEB_ENTRY, disallow: { to: { module: { origin: 'external', source: EDITOR_PACKAGES } } } },
  // core/md/dom-env.node.ts is imported only from node/ (and tests); last, so no allow above can re-open it
  { from: from('shared', 'core', 'server', 'cli', ...WEB, 'scripts'), disallow: { to: { file: { categories: 'dom-env' } } } },
]

export default [
  {
    ignores: [
      'node_modules/**', 'dist/**', '.e2e-dist/**', '.dist-check/**', 'test-results/**', 'playwright-report/**',
      'tests/e2e/.tmp/**', 'tests/corpus/fixtures/**', '**/*.d.ts',
      // generated plugin runtime (scripts/build-plugin.mjs): a 6 MB minified bundle and the vite build
      'plugins/*/runtime/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ['@babel/preset-typescript'],
          overrides: [{ test: /\.tsx$/, plugins: ['@babel/plugin-syntax-jsx'] }],
        },
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { boundaries, mdr: mdrPlugin },
    settings: {
      'import/resolver': { typescript: { project: './tsconfig.json' }, node: true },
      'boundaries/elements': ELEMENTS,
      'boundaries/files': FILES,
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', checkAllOrigins: true, checkInternals: true, policies: POLICIES }],
      'mdr/day0-stub': ['error', { merged: MERGED_MILESTONES }],
      // syntax-level correctness only (D52): nothing here needs type information
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-self-assign': 'error',
      'no-sparse-arrays': 'error',
      'no-dupe-else-if': 'error',
      'no-import-assign': 'error',
    },
  },
]
