// tests/e2e/p2-rects.spec.ts (P2; CONTRACTS §12.0.3 "One contract for both bridges", D28, §12.15).
//
// The editor-bridge contract (tests/contract/editor-bridge.contract.ts, the same assertion set the fake bridge passes
// in vitest) against P2's real bridge in Chromium, on the day-0 harness page (P2-owned ids and window.__mdrDebug only,
// §2.5). Two comment threads come from the agent route (Claude's `comment --quote`); the doc is long enough to scroll
// the container well past 500 px. Step 5's 200 px block is inserted through the editor by P2's own page hook.
import { CONSTANTS, PROTOCOL } from '../../shared/types'
import { editorBridgeContract, type BridgeContractResult } from '../contract/editor-bridge.contract'
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { expect, test } from './fixtures'

const DOC = 'p2-rects.md'
const BROWSER = browserChoice()

test.use({ serverKind: 'real', fixtureFiles: [], docFile: DOC })
test.skip(!BROWSER.available, BROWSER.reason)

function longDoc(): string {
  const para = (i: number): string => `Paragraph ${i} carries enough words to wrap across a line or two in the column, so the page is tall.`
  const parts = ['# Rects fixture', '']
  for (let i = 1; i <= 70; i++) {
    if (i === 12) parts.push('Here sits Anchor alpha inside an ordinary sentence.', '')
    if (i === 40) parts.push('And later Anchor omega sits further down the page.', '')
    parts.push(para(i), '')
  }
  return parts.join('\n')
}

async function agentBatch(origin: string, token: string, file: string, ops: unknown[]): Promise<void> {
  const r = await fetch(`${origin}/api/agent/batch?file=${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'X-MDR-Client': 'cli', 'X-MDR-Protocol': String(PROTOCOL), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops }),
  })
  expect(r.status, await r.clone().text()).toBe(200)
}

test('p2-rects: the real bridge passes the editor-bridge contract (§12.0.3)', async ({ page, server, tmpRoot }) => {
  tmpRoot.write(DOC, longDoc())
  await agentBatch(server.origin, server.token, DOC, [
    { op: 'comment', quote: 'Anchor alpha', body: 'First thread.' },
    { op: 'comment', quote: 'Anchor omega', body: 'Second thread.' },
  ])
  await page.setViewportSize({ width: 1280, height: 800 })
  const ed = await openEditor(page, { port: server.port, file: DOC })
  await expect(ed.testid('highlight')).toHaveCount(2)
  await page.evaluate(() => {
    const w = window as unknown as {
      __name?: (f: unknown) => unknown
      __mdrEditorTest: { insertBlockAbove(id: string, px: number): boolean }
      __mdrBridgeContract: { insertBlockAbove(id: string, px: number): void }
    }
    w.__name = (f) => f
    w.__mdrBridgeContract = { insertBlockAbove: (id, px) => void w.__mdrEditorTest.insertBlockAbove(id, px) }
  })
  const results = await page.evaluate(editorBridgeContract as unknown as () => Promise<BridgeContractResult[]>)
  expect(results.filter((r) => !r.ok)).toEqual([])
  expect(results.length).toBe(7)
  // the editor-ready mark exists for the perf budget (§11.7)
  expect(await page.evaluate(() => performance.getEntriesByName('mdr:editor-ready').length)).toBe(1)
  expect(CONSTANTS.MAX_QUOTE_CHARS).toBeGreaterThan(0)
})
