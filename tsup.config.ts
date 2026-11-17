// tsup.config.ts (integrator; CONTRACTS §1, §1.2, D38).
//
// cli/main.ts -> <outDir>/cli.js: one ESM bundle (shared, core, node and server bundled in), Node target = the
// `engines` floor, with exactly one `#!/usr/bin/env node` line and the executable bit. jsdom, chokidar and fsevents
// stay external (native or file-heavy). `--out-dir .e2e-dist` (build:e2e) is honoured. `clean` is off: dist/web is
// Vite's and lives in the same directory.
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig } from 'tsup'

const EXTERNAL = ['jsdom', 'chokidar', 'fsevents']
const SHEBANG = '#!/usr/bin/env node\n'

export default defineConfig((cli) => {
  const outDir = cli.outDir ?? 'dist'
  return {
    entry: { cli: 'cli/main.ts' },
    outDir,
    format: ['esm'],
    platform: 'node',
    target: 'node22.22',
    bundle: true,
    splitting: false,
    sourcemap: false,
    clean: false,
    dts: false,
    shims: false,
    external: EXTERNAL,
    // bundle every package except the externals (tsup externalizes `dependencies` by default)
    noExternal: [new RegExp(`^(?!(${EXTERNAL.join('|')})(/|$)).*`)],
    // CommonJS dependencies inside an ESM bundle call require() for node builtins
    banner: { js: "import { createRequire as __mdrCreateRequire } from 'node:module'; const require = __mdrCreateRequire(import.meta.url);" },
    async onSuccess() {
      const file = join(outDir, 'cli.js')
      const body = (await readFile(file, 'utf8')).replace(/^#![^\n]*\n/gm, '')
      await writeFile(file, SHEBANG + body)
      await chmod(file, 0o755)
    },
  }
})
