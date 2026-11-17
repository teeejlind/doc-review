#!/usr/bin/env node
// scripts/build-plugin.mjs (packaging). `npm run build:plugin` / `npm run check:plugin`.
//
// Builds the runtime half of the Claude Code plugin (doc-review):
//
//   plugins/doc-review/runtime/
//     mdr.mjs     ONE minified pure-JS bundle of cli/main.ts: every dependency inlined (jsdom included), no node_modules
//     web/        the SPA (a vite build, the same tree `npm run build` writes to dist/web)
//     BUILD.txt   the doc-review commit, the build command, the tool versions and the sha256 of every file above
//
// jsdom is the only package that touches its own files at runtime, so the bundle carries two patches, each ASSERTED
// (the build fails, naming the patch, if jsdom changed and a patch no longer applies):
//   1. living/css/helpers/computed-style.js reads browser/default-stylesheet.css with fs.readFileSync(path.resolve(
//      __dirname, ...)): the stylesheet text is inlined at build time.
//   2. living/xhr/XMLHttpRequest-impl.js does require.resolve("./xhr-sync-worker.js") at load time: stubbed. Synchronous
//      XHR (the only user of that worker) is never used by mdr.
// chokidar 5 needs no fsevents. Every remaining import of the bundle must be a node: builtin (asserted).
//
//   node scripts/build-plugin.mjs            build into the plugin's runtime/ (replaces it)
//   node scripts/build-plugin.mjs --check    rebuild into a temp dir, byte-compare it with the committed runtime/ (BUILD.txt's
//                                            commit line excepted), then run the committed bundle with NO node_modules: --version,
//                                            port, open, page HTTP 200, snapshot, suggest, status, stop. Exit 0 / 1.
//   node scripts/build-plugin.mjs --out DIR  build into DIR instead (no compare)
//
// Never writes dist/ and never `git add`s anything.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_RUNTIME = join(ROOT, 'plugins', 'doc-review', 'runtime')
// jsdom's optional canvas support: required lazily inside try/catch and absent here, which is exactly what mdr wants.
const OPTIONAL_ABSENT = new Set(['canvas'])
const BUILD_COMMAND = 'npm run build:plugin'
const COMMIT_LINE = /^doc-review commit: .*$/m
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const fail = (msg) => {
  console.error(`build-plugin: ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------------------------------------
// the bundle

/** Replace exactly one match of `re` in `src`; anything else means jsdom changed and the patch must be revisited. */
function patchOnce(name, src, re, replacement) {
  const hits = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
  if (!hits || hits.length !== 1) fail(`jsdom patch "${name}" matched ${hits ? hits.length : 0} time(s), expected 1 (did jsdom change? revisit scripts/build-plugin.mjs)`)
  const out = src.replace(re, () => replacement)
  if (out === src) fail(`jsdom patch "${name}" changed nothing`)
  return out
}

const JSDOM = join(ROOT, 'node_modules', 'jsdom')
const patched = { stylesheet: false, xhrWorker: false }

const inlineJsdom = {
  name: 'inline-jsdom',
  setup(b) {
    b.onLoad({ filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]css[\\/]helpers[\\/]computed-style\.js$/ }, (a) => {
      const css = readFileSync(join(JSDOM, 'lib', 'jsdom', 'browser', 'default-stylesheet.css'), 'utf8')
      const src = patchOnce(
        'default stylesheet',
        readFileSync(a.path, 'utf8'),
        /fs\.readFileSync\(\s*path\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\s*\{ encoding: "utf-8" \}\s*\)/,
        JSON.stringify(css),
      )
      patched.stylesheet = true
      return { contents: src, loader: 'js', resolveDir: dirname(a.path) }
    })
    b.onLoad({ filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ }, (a) => {
      const src = patchOnce('xhr sync worker', readFileSync(a.path, 'utf8'), /require\.resolve\("\.\/xhr-sync-worker\.js"\)/, '"xhr-sync-worker-unavailable-in-bundle"')
      patched.xhrWorker = true
      return { contents: src, loader: 'js', resolveDir: dirname(a.path) }
    })
  },
}

async function buildBundle(outFile) {
  const result = await build({
    entryPoints: [join(ROOT, 'cli', 'main.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.22',
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: 'none',
    // CommonJS dependencies inside an ESM bundle call require() for node builtins
    banner: { js: "import { createRequire as __mdrCreateRequire } from 'node:module'; const require = __mdrCreateRequire(import.meta.url);" },
    external: [...OPTIONAL_ABSENT],
    plugins: [inlineJsdom],
    logLevel: 'warning',
    absWorkingDir: ROOT,
  })
  if (!patched.stylesheet || !patched.xhrWorker) fail(`a jsdom patch was never reached (stylesheet: ${patched.stylesheet}, xhr worker: ${patched.xhrWorker})`)
  // No package may stay external: every import left in the output is a node builtin (or jsdom's optional canvas).
  const builtins = new Set(builtinModules)
  const out = Object.values(result.metafile.outputs)[0]
  const stray = out.imports
    .filter((i) => i.external && !i.path.startsWith('node:') && !builtins.has(i.path) && !OPTIONAL_ABSENT.has(i.path))
    .map((i) => i.path)
  if (stray.length) fail(`the bundle still imports packages at runtime: ${[...new Set(stray)].join(', ')}`)
  const text = readFileSync(outFile, 'utf8')
  if (/require\(["']fsevents["']\)|from["']fsevents["']/.test(text)) fail('the bundle imports fsevents')
  if (text.includes('xhr-sync-worker.js')) fail('the bundle still references xhr-sync-worker.js')
}

// ---------------------------------------------------------------------------------------------------------------------
// the SPA

function buildWeb(outDir) {
  const vite = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
  const env = { ...process.env }
  delete env.MDR_FAKE_EDITOR // a production build, never the fakes
  // vite lists every asset with a path relative to the cwd, which for a temp outDir is a wall of `../../..`: keep its
  // output and show it only when the build fails
  const r = spawnSync(vite, ['build', '--outDir', outDir, '--emptyOutDir'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env })
  if (r.error) throw r.error
  if (r.status !== 0) {
    process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`)
    fail(`vite build exited ${r.status}`)
  }
  if (!existsSync(join(outDir, 'index.html'))) fail('vite build wrote no index.html')
}

// ---------------------------------------------------------------------------------------------------------------------
// THIRD_PARTY_LICENSES.txt: the package.json + license text of every production dependency, transitively. Both the
// CLI bundle and the SPA draw only from that closure, so it is a (slight) superset of what ships, never a subset.

/** The directory of package `name` as `fromDir` resolves it (walks up through node_modules folders), or null. */
function findPackage(fromDir, name) {
  for (let d = fromDir; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name)
    if (existsSync(join(p, 'package.json'))) return p
    if (dirname(d) === d) return null
  }
}

function collectLicenses() {
  const seen = new Map()
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const visit = (name, fromDir) => {
    const dir = findPackage(fromDir, name)
    if (!dir) return // an optional dependency that was not installed on this platform
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const key = `${pkg.name}@${pkg.version}`
    if (seen.has(key)) return
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f) && statSync(join(dir, f)).isFile())
    const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'UNKNOWN')
    seen.set(key, { key, license, text: file ? readFileSync(join(dir, file), 'utf8').trim() : null })
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dir)
  }
  for (const dep of Object.keys(rootPkg.dependencies ?? {})) visit(dep, ROOT)
  return [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
}

function writeLicenses(outDir) {
  const pkgs = collectLicenses()
  const parts = [
    'Third-party software in this runtime (mdr.mjs and web/), generated by scripts/build-plugin.mjs.',
    'mdr itself is MIT licensed (see LICENSE in the repository). Each package below is distributed under the license shown.',
    '',
    ...pkgs.flatMap((p) => ['='.repeat(78), `${p.key}  (${p.license})`, '='.repeat(78), p.text ?? '(no license file is shipped with this package; the license above comes from its package.json)', '']),
  ]
  writeFileSync(join(outDir, 'THIRD_PARTY_LICENSES.txt'), parts.join('\n'))
  return pkgs.length
}

// ---------------------------------------------------------------------------------------------------------------------
// BUILD.txt

/** Every regular file under `dir` (POSIX paths relative to it), sorted. */
function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) out.push(relative(dir, p).split('\\').join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function commitLine() {
  const head = git(['rev-parse', 'HEAD']) ?? 'unknown (not a git checkout)'
  // the runtime itself and the plugin docs are outputs, not sources: ignore them when asking "dirty?"
  const dirty = git(['status', '--porcelain', '--', '.', ':(exclude)plugins']) ?? ''
  return `doc-review commit: ${head}${dirty ? ' (plus uncommitted changes)' : ''}`
}

function toolVersion(pkg) {
  return JSON.parse(readFileSync(join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version
}

function writeBuildTxt(outDir, mdrVersion) {
  const files = listFiles(outDir).filter((f) => f !== 'BUILD.txt')
  const lines = [
    'doc-review runtime (generated; do not edit by hand)',
    commitLine(),
    `build command: ${BUILD_COMMAND}`,
    `mdr version: ${mdrVersion}`,
    `bundler: esbuild ${toolVersion('esbuild')} (minified, ESM, target node22.22, jsdom inlined with 2 asserted patches); web: vite ${toolVersion('vite')}`,
    'runs on: Node >= 22.22 (the plugin installs Node 26.5.0 itself, see scripts/runtime.lock)',
    '',
    'sha256  file',
    ...files.map((f) => `${sha256(readFileSync(join(outDir, f)))}  ${f}`),
    '',
  ]
  writeFileSync(join(outDir, 'BUILD.txt'), lines.join('\n'))
}

function mdrVersionOf(outDir) {
  const r = spawnSync(process.execPath, [join(outDir, 'mdr.mjs'), '--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
  if (r.status !== 0) fail(`the new bundle failed \`--version\`: ${r.stderr || r.stdout}`)
  return JSON.parse(r.stdout).version
}

async function buildInto(outDir) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  console.log('build-plugin: building the SPA (vite)')
  buildWeb(join(outDir, 'web'))
  console.log('build-plugin: bundling cli/main.ts -> mdr.mjs')
  await buildBundle(join(outDir, 'mdr.mjs'))
  writeLicenses(outDir)
  writeBuildTxt(outDir, mdrVersionOf(outDir))
}

// ---------------------------------------------------------------------------------------------------------------------
// --check: byte-compare, then run the committed bundle with no node_modules anywhere above it

function hashTree(dir) {
  const m = new Map()
  for (const f of listFiles(dir)) m.set(f, f === 'BUILD.txt' ? sha256(readFileSync(join(dir, f), 'utf8').replace(COMMIT_LINE, 'doc-review commit: <ignored>')) : sha256(readFileSync(join(dir, f))))
  return m
}

function compareTrees(fresh, committed) {
  const want = hashTree(fresh)
  const have = hashTree(committed)
  const diffs = []
  for (const [p, h] of want) {
    if (!have.has(p)) diffs.push(`missing from runtime/: ${p}`)
    else if (have.get(p) !== h) diffs.push(`differs:             ${p}`)
  }
  for (const p of have.keys()) if (!want.has(p)) diffs.push(`extra in runtime/:   ${p}`)
  return diffs
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Run `node mdr.mjs args...` with a scrubbed environment (the "no node_modules, empty HOME" contract). */
function runMdr(app, home, args, input) {
  const r = spawnSync(process.execPath, [join(app, 'mdr.mjs'), ...args], {
    cwd: dirname(app),
    encoding: 'utf8',
    input,
    timeout: 60_000,
    env: { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, LANG: 'C' },
  })
  let json = null
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop() ?? '')
  } catch {
    // reported by the caller
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}

async function smoke(runtimeDir) {
  // Copy next to nothing: a fresh directory under the temp dir, so no node_modules can be found walking up.
  const base = mkdtempSync(join(tmpdir(), 'mdr-plugin-smoke-'))
  const app = join(base, 'app')
  const home = join(base, 'home')
  const docs = join(base, 'docs')
  mkdirSync(home, { recursive: true })
  mkdirSync(docs, { recursive: true })
  cpSync(join(runtimeDir, 'mdr.mjs'), join(app, 'mdr.mjs'))
  cpSync(join(runtimeDir, 'web'), join(app, 'web'), { recursive: true })
  const doc = join(docs, 'hello.md')
  writeFileSync(doc, '# Hello\n\nThis is the first paragraph of the smoke test.\n\nAnd a second one.\n')
  const problems = []
  const need = (cond, what) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`)
    if (!cond) problems.push(what)
  }
  let served = false
  try {
    // refuse to pass if a node_modules is reachable from the bundle
    let d = app
    let reachable = false
    for (;;) {
      if (existsSync(join(d, 'node_modules'))) reachable = true
      const up = dirname(d)
      if (up === d) break
      d = up
    }
    need(!reachable, 'no node_modules reachable from the bundle')

    const v = runMdr(app, home, ['--version'])
    need(v.code === 0 && v.json?.ok === true && typeof v.json.version === 'string', `--version -> ${v.json?.version ?? v.stderr.trim()}`)

    const p = runMdr(app, home, ['port', docs])
    need(p.code === 0 && p.json?.ok === true && Number.isInteger(p.json.formulaPort), `port -> formula ${p.json?.formulaPort}`)

    const o = runMdr(app, home, ['open', doc])
    served = o.json?.ok === true
    need(o.code === 0 && o.json?.ok === true && /^http:\/\/127\.0\.0\.1:\d+\/\?file=/.test(o.json.url ?? ''), `open -> ${o.json?.url ?? o.stderr.trim()}`)
    need(o.json?.waiter == null || typeof o.json.waiter.command === 'string', 'open prints a waiter spec (or null with a reason)')

    if (o.json?.url) {
      const res = await fetch(o.json.url)
      const html = await res.text()
      need(res.status === 200 && html.includes('name="mdr-token"'), `page ${o.json.url} -> HTTP ${res.status}, bootstrap meta present`)
      const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1]
      const js = src ? await fetch(new URL(src, o.json.url)) : null
      need(js?.status === 200 && (js.headers.get('content-type') ?? '').includes('javascript'), `app script ${src} -> HTTP ${js?.status}`)
      await js?.arrayBuffer()
    }

    const s = runMdr(app, home, ['snapshot', doc, '--md'])
    need(s.code === 0 && s.json?.ok === true && s.json.blocks?.length === 3, `snapshot --md -> ${s.json?.blocks?.length} blocks`)

    const g = runMdr(app, home, ['suggest', doc, '--quote', 'first paragraph', '--replace', 'opening paragraph', '--reason', 'smoke test'])
    need(g.code === 0 && g.json?.ok === true, `suggest -> ${g.json?.ok === true ? 'ok' : (g.stdout || g.stderr).trim().slice(0, 160)}`)

    const t = runMdr(app, home, ['status', doc])
    need(t.code === 0 && t.json?.ok === true, 'status')
    const after = runMdr(app, home, ['snapshot', doc])
    need(after.json?.suggestions?.length === 1, `the suggestion is in the review log (${after.json?.suggestions?.length ?? 'none'})`)
  } finally {
    if (served) {
      const z = runMdr(app, home, ['stop', docs])
      need(z.code === 0 && z.json?.ok === true, `stop -> stopped: ${z.json?.stopped}`)
      // give the detached server a beat to release the port before the folder disappears
      await sleep(300)
    }
    rmSync(base, { recursive: true, force: true })
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const outIdx = argv.indexOf('--out')
  const out = outIdx >= 0 ? argv[outIdx + 1] : null
  if (outIdx >= 0 && !out) fail('--out needs a directory')

  if (out) {
    await buildInto(out)
    console.log(`build-plugin: wrote ${out}`)
    return
  }
  if (!check) {
    await buildInto(PLUGIN_RUNTIME)
    const files = listFiles(PLUGIN_RUNTIME)
    console.log(`build-plugin: wrote ${relative(ROOT, PLUGIN_RUNTIME)} (${files.length} files, mdr.mjs ${(statSync(join(PLUGIN_RUNTIME, 'mdr.mjs')).size / 1e6).toFixed(1)} MB)`)
    return
  }

  if (!existsSync(join(PLUGIN_RUNTIME, 'mdr.mjs'))) fail('check:plugin: runtime/ is not built yet; run `npm run build:plugin`')
  const tmp = mkdtempSync(join(tmpdir(), 'mdr-plugin-check-'))
  let diffs = []
  try {
    await buildInto(join(tmp, 'runtime'))
    diffs = compareTrees(join(tmp, 'runtime'), PLUGIN_RUNTIME)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (diffs.length) {
    console.error(`check:plugin: runtime/ is stale against the sources (${diffs.length} file(s)); run \`npm run build:plugin\` and commit it`)
    for (const d of diffs) console.error(`  ${d}`)
    process.exit(1)
  }
  console.log(`check:plugin: runtime/ matches a fresh build (${listFiles(PLUGIN_RUNTIME).length} files)`)

  console.log('check:plugin: running the committed bundle with no node_modules and an empty HOME')
  const problems = await smoke(PLUGIN_RUNTIME)
  if (problems.length) {
    console.error(`check:plugin: ${problems.length} smoke check(s) failed`)
    process.exit(1)
  }
  console.log('check:plugin: ok')
}

await main()
