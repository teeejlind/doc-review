// node/dom.ts (P1; written by the integrator on day 0). Side-effect module: installs the jsdom globals core/md needs.
//
// Milkdown and ProseMirror must find the DOM globals before their modules evaluate (S2 FINDINGS, "Headless
// Milkdown"), and core/md/dom-env.node.ts may only be imported from node/ (CONTRACTS §2.3). So every node entry point
// (cli/main.ts, and server/index.ts for in-process callers) imports this module FIRST, before anything that pulls in
// core/md.
// `.js` on purpose: tsx (npm run dev:server, the CLI contract test) reads a bare `dom-env.node` as a native-addon path
// and never tries `.ts`; tsc, Vite, esbuild and tsx all map `dom-env.node.js` to `dom-env.node.ts`.
import { installDom } from '../core/md/dom-env.node.js'

installDom()

export { installDom }
