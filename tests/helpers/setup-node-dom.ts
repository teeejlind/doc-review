// tests/helpers/setup-node-dom.ts (integrator, day 0): the vitest setupFile of the "node" project (vitest.config.ts).
//
// core/md boots Milkdown headless on jsdom, and the jsdom globals have to exist before any Milkdown or ProseMirror
// module evaluates (S2 FINDINGS, "Headless Milkdown"). A setupFile runs before each test file's imports, so every
// node-project test sees the same globals the server process installs before its first createMd().
// `.js` on purpose: tsx (and other plain Node loaders) read a bare `dom-env.node` as a native-addon path and never try
// `.ts`; tsc, Vite, esbuild and tsx all map `dom-env.node.js` to `dom-env.node.ts`.
//
// Generalization pass: the per-user settings are pinned so no developer's own setup leaks in. The display name is
// "TJ" (TJ's MDR_USER_NAME, so every existing "TJ sent …" expectation holds), nothing is protected (the default;
// guard tests set MDR_PROTECTED_SEGMENTS themselves), and MDR_CMD / MDR_IDLE_EXIT_MIN are unset.
import { installDom } from '../../core/md/dom-env.node.js'
import { pinUserEnv } from './userEnv'

pinUserEnv(process.env)
installDom()
