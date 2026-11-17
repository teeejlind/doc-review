// server/static.ts (P1). The SPA from the `web/` dir next to the running cli.js, with the bootstrap meta tags
// injected into index.html (CONTRACTS §8.3 static row, §12.0.2, D43).
//
// - `<!--mdr:meta-->` in index.html is replaced with renderMetaTags(?file=): mdr-token, mdr-root, mdr-root-hash,
//   mdr-port, mdr-file (validated per §8.1 step 7, empty when absent or invalid), mdr-file-error (the ErrorCode when
//   ?file= was given but invalid, else absent), mdr-version, mdr-protocol, mdr-fingerprint, then (generalization
//   pass, read per request, when the context provides them) mdr-user-name and mdr-user-source (the human's display
//   name and where it came from) and mdr-cmd (MDR_CMD || 'mdr', for the copied prompt), and mdr-test-hooks only under
//   MDR_TEST_HOOKS=1. Values are HTML-escaped; the page is served Cache-Control: no-store.
// - An invalid or missing ?file= still returns 200, so the SPA shows its empty or error state.
// - The same renderMetaTags serves GET /__dev/meta under MDR_DEV_ORIGIN=1 (app.ts), so `npm run dev` boots against Vite (D43).
// Web dir: MDR_WEB_DIR when set, else `<dir of the running bundle>/web` (dist/cli.js → dist/web, .e2e-dist/cli.js →
// .e2e-dist/web); from source (tsx, vitest) it falls back to the repo's dist/web.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { validateFile } from './security'

export interface MetaContext {
  root: string
  rootHash: string
  port: number
  token: string
  version: string
  protocol: number
  schemaFingerprint: string
  testHooks: boolean
  /** The human's display name and its source, read per page load (web/src/identity.ts reads mdr-user-name / -source). */
  user?: () => { displayName: string; source: string }
  /** The command the copied prompt tells Claude to run (MDR_CMD || 'mdr'). */
  agentCmd?: () => string
}

export const META_PLACEHOLDER = '<!--mdr:meta-->'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** The `<meta name="mdr-*">` block for a request's ?file= value (§12.0.2). */
export function renderMetaTags(fileParam: string | null | undefined, ctx: MetaContext): string {
  let file = ''
  let fileError: string | null = null
  if (fileParam) {
    const v = validateFile(ctx.root, fileParam)
    if (v.ok) file = v.file
    else fileError = v.code
  }
  const tags: Array<[string, string]> = [
    ['mdr-token', ctx.token],
    ['mdr-root', ctx.root],
    ['mdr-root-hash', ctx.rootHash],
    ['mdr-port', String(ctx.port)],
    ['mdr-file', file],
  ]
  if (fileError) tags.push(['mdr-file-error', fileError])
  tags.push(['mdr-version', ctx.version], ['mdr-protocol', String(ctx.protocol)], ['mdr-fingerprint', ctx.schemaFingerprint])
  if (ctx.user) {
    const u = ctx.user()
    tags.push(['mdr-user-name', u.displayName], ['mdr-user-source', u.source])
  }
  if (ctx.agentCmd) tags.push(['mdr-cmd', ctx.agentCmd()])
  if (ctx.testHooks) tags.push(['mdr-test-hooks', '1'])
  return tags.map(([name, content]) => `<meta name="${esc(name)}" content="${esc(content)}">`).join('\n')
}

/** The directory the SPA is served from. */
export function webDir(): string {
  if (process.env.MDR_WEB_DIR) return process.env.MDR_WEB_DIR
  const here = dirname(fileURLToPath(import.meta.url))
  const primary = join(here, 'web')
  if (existsSync(join(primary, 'index.html'))) return primary
  const fromSource = join(here, '..', 'dist', 'web')
  return existsSync(join(fromSource, 'index.html')) ? fromSource : primary
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
}

/** GET / (and /index.html) with meta injection, plus every other file under the web dir. */
export function staticRoutes(ctx: MetaContext, dir: string = webDir()): Hono {
  const app = new Hono()
  const index = (fileParam: string | undefined): Response => {
    const path = join(dir, 'index.html')
    if (!existsSync(path)) {
      return new Response(`mdr: the web build is missing (${path}); run npm run build:web\n`, {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    const html = readFileSync(path, 'utf8').replace(META_PLACEHOLDER, () => renderMetaTags(fileParam, ctx))
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  app.get('/', (c) => index(c.req.query('file')))
  app.get('/index.html', (c) => index(c.req.query('file')))
  app.get('*', async (c, next) => {
    const p = c.req.path
    if (p.startsWith('/api/') || p.startsWith('/__')) return next()
    let rel: string
    try {
      rel = normalize(decodeURIComponent(p)).replace(/^[/\\]+/, '')
    } catch {
      return next()
    }
    const abs = join(dir, rel)
    const back = relative(dir, abs)
    if (!rel || back.startsWith('..') || isAbsolute(back) || back.split(sep).some((s) => s.startsWith('.'))) return next()
    if (!existsSync(abs) || !statSync(abs).isFile()) return next()
    const type = TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream'
    const cache = rel.startsWith('assets' + sep) || rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    return new Response(readFileSync(abs), { status: 200, headers: { 'Content-Type': type, 'Cache-Control': cache } })
  })
  return app
}
