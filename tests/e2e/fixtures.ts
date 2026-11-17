// tests/e2e/fixtures.ts (integrator, day 0; CONTRACTS §1.3 e2e row, §2.5).
//
// The shared Playwright fixtures every e2e spec uses: `tmpRoot`, `server`, `cli`, `webClient`, `editorPage`, `debug`.
// Each test gets its own tmp root under tests/e2e/.tmp/ (a copy of the committed fixture docs), a tmp HOME, and a
// server on 29000 + workerIndex*10 started with MDR_TEST_HOOKS=1: the built `.e2e-dist/cli.js serve --foreground`
// (serverKind 'real', the default) or startFakeServer (serverKind 'fake': fakeApp in the test process, for p2-*/p3-*
// specs before M2). Producers extend these in tests/e2e/fixtures/pN.ts, never by editing this file.
//
//   import { test, expect } from './fixtures'
//   test.use({ serverKind: 'fake', docFile: 'syn__tables.md' })
//   test('…', async ({ webClient, editorPage }) => { … })
import { test as base, expect } from '@playwright/test'
import type { BatchRequest } from '../../shared/types'
import { DEFAULT_DOC } from '../fixtures/index'
import { openEditor, type DebugProxy, type EditorPage } from '../helpers/openEditor'
import { runCli, spawnCli, type CliProcess, type CliRun, type RunCliOptions } from '../helpers/runCli'
import { startFakeServer, type FakeServerHandle } from '../helpers/startFakeServer'
import { startServer, workerPort, type SpawnedServer } from '../helpers/startServer'
import { tmpRoot as makeTmpRoot, type TmpRoot } from '../helpers/tmpRoot'
import { webClient as makeWebClient, type WebClient } from '../helpers/webClient'

/** The server a spec talks to, whichever kind it is. */
export interface ServerUnderTest {
  readonly kind: 'real' | 'fake'
  readonly root: string
  readonly port: number
  /** http://127.0.0.1:<port> (also the allowed Origin). */
  readonly origin: string
  readonly url: string
  readonly token: string
  /** Present for kind 'real'. */
  readonly real?: SpawnedServer
  /** Present for kind 'fake'. */
  readonly fake?: FakeServerHandle
  /** Stop it (SIGTERM for real; close for fake). Idempotent. */
  stop(): Promise<void>
  /** Stop and start again on the same root and port; returns the new handle (the fixture keeps tracking it). */
  restart(o?: { env?: Record<string, string | undefined> }): Promise<ServerUnderTest>
}

/** The CLI bound to this test's root, HOME and server env. */
export interface CliHelper {
  run(args: readonly string[], o?: RunCliOptions): Promise<CliRun>
  spawn(args: readonly string[], o?: RunCliOptions): CliProcess
  /** `mdr batch <abs file>` with the request on stdin. */
  batch(file: string, req: BatchRequest, o?: RunCliOptions): Promise<CliRun>
  /** Absolute path of a root-relative file (what the CLI takes). */
  abs(file: string): string
}

export interface MdrOptions {
  /** 'real' = .e2e-dist/cli.js serve --foreground (default); 'fake' = startFakeServer over fakeApp. */
  serverKind: 'real' | 'fake'
  /** Fixture docs copied into the root ('all' by default). */
  fixtureFiles: readonly string[] | 'all'
  /** The doc webClient and editorPage open. Default basic.md. */
  docFile: string
  /** Extra env for the real server (MDR_TEST_HEARTBEAT_MS, MDR_TEST_TURN_IDLE_MS, MDR_TEST_PROTOCOL, ...). */
  serverEnv: Record<string, string>
  /** Port offset inside the worker's window of 10 (for specs that run two servers). */
  portOffset: number
}

export interface MdrFixtures {
  tmpRoot: TmpRoot
  server: ServerUnderTest
  cli: CliHelper
  webClient: WebClient
  editorPage: EditorPage
  debug: DebugProxy
}

function wrapReal(s: SpawnedServer, env: Record<string, string>, home: string): ServerUnderTest {
  let cur = s
  let stopped = false
  const self: ServerUnderTest = {
    kind: 'real',
    get root() { return cur.root },
    get port() { return cur.port },
    get origin() { return cur.origin },
    get url() { return cur.url },
    get token() { return cur.token },
    get real() { return cur },
    async stop() {
      if (stopped) return
      stopped = true
      await cur.stop('SIGTERM')
    },
    async restart(o = {}) {
      if (!stopped) await cur.stop('SIGTERM')
      cur = await startServer({ root: cur.root, port: cur.port, home, env: { ...env, ...(o.env ?? {}) } })
      stopped = false
      return self
    },
  }
  return self
}

function wrapFake(f: FakeServerHandle): ServerUnderTest {
  let cur = f
  let stopped = false
  const self: ServerUnderTest = {
    kind: 'fake',
    get root() { return cur.root },
    get port() { return cur.port },
    get origin() { return cur.origin },
    get url() { return cur.url },
    get token() { return cur.token },
    get fake() { return cur },
    async stop() {
      if (stopped) return
      stopped = true
      await cur.close('stop')
    },
    async restart() {
      cur = stopped ? await startFakeServer({ root: cur.root, port: cur.port, token: cur.token }) : await cur.restart()
      stopped = false
      return self
    },
  }
  return self
}

export const test = base.extend<MdrOptions & MdrFixtures>({
  serverKind: ['real', { option: true }],
  fixtureFiles: ['all', { option: true }],
  docFile: [DEFAULT_DOC, { option: true }],
  serverEnv: [{}, { option: true }],
  portOffset: [0, { option: true }],

  tmpRoot: async ({ fixtureFiles }, use, testInfo) => {
    const r = makeTmpRoot({ name: testInfo.titlePath.slice(1).join('-'), fixtures: fixtureFiles })
    await use(r)
    // keep the root of a failed test for inspection (tests/e2e/.tmp is gitignored)
    if (testInfo.status === testInfo.expectedStatus) r.cleanup()
  },

  server: async ({ tmpRoot, serverKind, serverEnv, portOffset }, use) => {
    const port = workerPort(portOffset)
    const s = serverKind === 'fake'
      ? wrapFake(await startFakeServer({ root: tmpRoot.root, port }))
      : wrapReal(await startServer({ root: tmpRoot.root, port, home: tmpRoot.home, env: serverEnv }), serverEnv, tmpRoot.home)
    await use(s)
    await s.stop()
  },

  cli: async ({ tmpRoot, serverEnv }, use) => {
    const base: RunCliOptions = { home: tmpRoot.home, env: { ...serverEnv } }
    const merge = (o: RunCliOptions = {}): RunCliOptions => ({ ...base, ...o, env: { ...(base.env ?? {}), ...(o.env ?? {}) } })
    await use({
      run: (args, o) => runCli(args, merge(o)),
      spawn: (args, o) => spawnCli(args, merge(o)),
      batch: (file, req, o) => runCli(['batch', tmpRoot.path(file)], { ...merge(o), stdin: req }),
      abs: (file) => tmpRoot.path(file),
    })
  },

  webClient: async ({ server, docFile }, use) => {
    const c = await makeWebClient({ port: server.port, root: server.root, file: docFile, token: server.token })
    await use(c)
    await c.close()
  },

  editorPage: async ({ page, server, docFile }, use) => {
    await use(await openEditor(page, { port: server.port, file: docFile }))
  },

  debug: async ({ editorPage }, use) => {
    await use(editorPage.debug)
  },
})

export { expect }
