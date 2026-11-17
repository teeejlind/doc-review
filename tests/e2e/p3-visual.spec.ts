// tests/e2e/p3-visual.spec.ts (P3; CONTRACTS §12.2.3 visual baseline, §14 P3 E2E "p3-visual").
//
// Light and dark captures of the §12.2.3 scenario (three open comment threads, Suggesting mode on, one reply being
// typed, a resolved thread shown, the top-bar chrome) at 1440×900 and 800×900, written to test-results/visual/ for
// the side-by-side with tests/visual/reference/ in QA_REPORT.md. TJ signs off the comparison; this spec asserts only
// that each capture shows the scenario.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentOp } from '../../shared/types'
import { openEditor } from '../helpers/openEditor'
import { REPO_ROOT } from '../helpers/tmpRoot'
import { expect, test } from './fixtures'
import { openRailSettings, P3_SERVER_KIND, railDoc, railSettled, sel } from './fixtures/p3'

const FILE = 'visual.md'
test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: FILE })
const OUT = join(REPO_ROOT, 'test-results', 'visual')

for (const scheme of ['light', 'dark'] as const)
  for (const [w, h] of [[1440, 900], [800, 900], [600, 900]] as const) {
    test(`capture: ${scheme} ${w}×${h}`, async ({ page, server, tmpRoot, cli }) => {
      tmpRoot.write(FILE, railDoc(14))
      const ops: AgentOp[] = [
        { op: 'comment', quote: 'marker1x', body: 'Is this the framing we want to open with?' },
        { op: 'comment', quote: 'marker2x', body: 'Can we cite the source for this?' },
        { op: 'suggest', quote: 'marker4x', replace: 'marker4x (as revised)', reason: 'Tighter wording.' },
        { op: 'comment', quote: 'marker6x', body: 'Resolved: fixed in the last pass.' },
      ]
      const r = await cli.batch(FILE, { ops })
      expect(r.ok, r.stdout + r.stderr).toBe(true)
      const resolved = (JSON.parse(r.stdout) as { results: Array<{ thread?: string }> }).results[3]!.thread!
      expect((await cli.batch(FILE, { ops: [{ op: 'resolve', thread: resolved as never }] })).ok).toBe(true)

      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: w, height: h })
      const ed = await openEditor(page, { port: server.port, file: FILE })
      await ed.bridge((b) => b.setMode('suggesting'))
      await expect(page.locator('#mdr-app')).toHaveAttribute('data-mode', 'suggesting')
      if (w >= 640) {
        await openRailSettings(page)
        await page.locator(sel('showResolved')).click()
        // a reply being typed in the first card
        const card = page.locator(sel('card')).first()
        await card.locator(sel('cardReply')).click()
        await page.keyboard.type('Agreed. I will tighten the opening and', { delay: 5 })
      } else {
        await page.locator(sel('highlight')).first().click()
        await expect(page.locator(sel('sheet'))).toHaveAttribute('data-open', 'true')
      }
      await railSettled(page, 300)
      mkdirSync(OUT, { recursive: true })
      await page.screenshot({ path: join(OUT, `mdr-${scheme}-${w}x${h}.png`) })
      await expect(page.locator(sel('card')).first()).toBeVisible()
    })
  }
