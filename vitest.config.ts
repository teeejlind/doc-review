// vitest.config.ts (integrator; CONTRACTS §1, §1.3).
//
// Two projects:
// - "node": tests/unit/{shared,core,node,server,cli,handoff}, tests/contract, tests/corpus. Node environment with the
//   jsdom globals core/md needs installed first (tests/helpers/setup-node-dom.ts), exactly as the server installs them.
// - "dom": tests/unit/web/** in vitest's jsdom environment, with the React plugin for .tsx.
// `npm run corpus` runs tests/corpus/run.ts with tsx, then `vitest run --project node tests/unit/core/suggest/g5.test.ts`.
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const NODE_DIRS = '{shared,core,node,server,cli,handoff}'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [`tests/unit/${NODE_DIRS}/**/*.test.ts`, 'tests/contract/**/*.test.ts', 'tests/corpus/**/*.test.ts'],
          exclude: ['tests/corpus/fixtures/**'],
          setupFiles: ['tests/helpers/setup-node-dom.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/unit/web/**/*.test.{ts,tsx}'],
          testTimeout: 30_000,
        },
      },
    ],
  },
})
