// playwright.config.ts (integrator; CONTRACTS §1, §1.3).
//
// tests/e2e against the app built into .e2e-dist/ (never dist/). No webServer: the shared fixtures in
// tests/e2e/fixtures.ts spawn one server per spec on port 29000 + workerIndex*10 over a tmp root and a tmp HOME.
// The chromium project drives Playwright's bundled Chromium, or the installed Google Chrome (`chrome` channel) when the
// bundled build is absent; tests/helpers/browser.ts decides, and MDR_PW_CHANNEL overrides it.
import { defineConfig, devices } from '@playwright/test'
import { browserChoice } from './tests/helpers/browser'

const { channel } = browserChoice()

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  workers: 4,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: '**/p3-perf.spec.ts', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } },
    // P3 merge (CONTRACT_CHANGES, P3's §11.7 isolation row): the wall-clock budgets run alone and untraced (Playwright's
    // per-action DOM snapshot would land inside the measured main thread). `npm run e2e` runs this project after the
    // chromium one has passed; no `dependencies`, because a dependency project runs in full even under a file filter,
    // which would make `npm run perf` (and any filtered run that includes p3-perf) run the whole suite first.
    {
      name: 'perf',
      testMatch: '**/p3-perf.spec.ts',
      workers: 1,
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}), trace: 'off' },
    },
  ],
})
