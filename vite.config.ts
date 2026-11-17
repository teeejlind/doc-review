// vite.config.ts (integrator; CONTRACTS §1, §1.2, §2.4 item 6, §12.0.2, D43).
//
// - root web/, output dist/web. `--outDir` overrides it and, unlike Vite's default, is resolved against the working
//   directory (the package root under npm scripts), so `build:e2e`'s `--outDir .e2e-dist/web` lands in .e2e-dist/web.
// - `npm run dev`: /api is proxied to the dev server on 127.0.0.1:$MDR_DEV_PORT (Host rewritten so the server's Host
//   check passes; the page's Origin is kept, which MDR_DEV_ORIGIN=1 admits), and the serve-only `mdr-dev-meta` plugin
//   fills <!--mdr:meta--> from the server's GET /__dev/meta. Production and e2e builds never include that plugin.
// - MDR_FAKE_EDITOR=1 (build time) swaps P2's two entry modules for tests/fakes/web-{session,editor}.ts, so P3's real
//   shell runs before P2 lands. Production and integration builds never set it.
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const REPO = fileURLToPath(new URL('.', import.meta.url))
const DEV_PORT = process.env.MDR_DEV_PORT ?? '8299'
const VITE_PORT = Number(process.env.MDR_DEV_VITE_PORT ?? 5173)
const META_PLACEHOLDER = '<!--mdr:meta-->'

/** `--outDir` relative to the working directory, not to `root`. */
function outDirFromCwd(): Plugin {
  return {
    name: 'mdr-outdir-from-cwd',
    config(c) {
      const out = c.build?.outDir
      if (out !== undefined && !isAbsolute(out)) return { build: { outDir: resolve(process.cwd(), out) } }
      return undefined
    },
  }
}

/** §12.0.2: dev only. Replaces the placeholder with the dev server's <meta name="mdr-*"> fragment for this ?file=. */
function mdrDevMeta(): Plugin {
  return {
    name: 'mdr-dev-meta',
    apply: 'serve',
    async transformIndexHtml(html, ctx) {
      const file = new URL(ctx.originalUrl ?? ctx.path, 'http://vite.invalid').searchParams.get('file')
      const query = file === null ? '' : `?file=${encodeURIComponent(file)}`
      try {
        const res = await fetch(`http://127.0.0.1:${DEV_PORT}/__dev/meta${query}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return html.replace(META_PLACEHOLDER, await res.text())
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        console.warn(`[mdr-dev-meta] no meta from the dev server on 127.0.0.1:${DEV_PORT} (${why}); is \`npm run dev:server\` running?`)
        return html.replace(META_PLACEHOLDER, `<!-- mdr-dev-meta: dev server on 127.0.0.1:${DEV_PORT} unreachable (${why}) -->`)
      }
    },
  }
}

/** §2.4 item 6: under MDR_FAKE_EDITOR=1, imports that resolve to P2's entry modules get the fakes instead. */
function fakeEditor(): Plugin {
  const swap = new Map([
    [resolve(REPO, 'web/src/session/index.ts'), resolve(REPO, 'tests/fakes/web-session.ts')],
    [resolve(REPO, 'web/src/editor/index.ts'), resolve(REPO, 'tests/fakes/web-editor.ts')],
  ])
  return {
    name: 'mdr-fake-editor',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || swap.has(importer)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      const fake = resolved ? swap.get(resolved.id.split('?')[0]!) : undefined
      return fake ?? null
    },
  }
}

export default defineConfig({
  root: resolve(REPO, 'web'),
  plugins: [react(), outDirFromCwd(), mdrDevMeta(), ...(process.env.MDR_FAKE_EDITOR === '1' ? [fakeEditor()] : [])],
  build: {
    outDir: resolve(REPO, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: VITE_PORT,
    strictPort: true,
    fs: { allow: [REPO] },
    proxy: {
      '/api': { target: `http://127.0.0.1:${DEV_PORT}`, changeOrigin: true },
    },
  },
})
