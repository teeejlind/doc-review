// tests/e2e/p3-a11y.spec.ts (P3; CONTRACTS §11.6, R7.4, §14 P3 E2E "p3-a11y").
//
// axe (@axe-core/playwright) in light and dark over an all-states page: TJ's and Claude's threads, a Claude
// suggestion, a resolved thread shown, a detached thread, a whole-doc comment, an unread marker, a toast, a banner, the
// save chip in a warning state, the Claude badge, and (second pass) the history panel and the narrow sheet. Zero
// serious or critical violations. With the real P2 the doc's frontmatter, table, code block and raw HTML block bring
// P2's styled states into the same pass, and the session states are raised for real: Send with no waiter (the
// copied toast and the waiting badge), a Claude comment after it (the "Claude replied" button), and a second tab
// taking over (the tab-not-leader banner and the read-only save chip). Then the keyboard-only flow of §11.6: open,
// comment, reply, next/prev, toggle mode, accept, send.
//
// P2_KNOWN lists the P2-owned nodes axe flags on the real build, reported to P2 from the P3 final pass. Exactly those
// nodes under exactly that rule are set aside (and attached to the test as an annotation); anything else fails.
import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import type { AgentOp } from '../../shared/types'
import { openEditor } from '../helpers/openEditor'
import type { WebClient } from '../helpers/webClient'
import { expect, test, type CliHelper } from './fixtures'
import { fakeEmit, installClipboard, openRailSettings, P3_SERVER_KIND, railSettled, sel, selectText } from './fixtures/p3'

const FILE = 'a11y.md'
test.use({ serverKind: P3_SERVER_KIND, fixtureFiles: [], docFile: FILE })

const DOC = [
  '---',
  'title: Accessibility pass',
  'status: Draft',
  '---',
  '',
  '# Accessibility pass',
  '',
  'The opening paragraph carries the first comment from TJ.',
  '',
  'Claude suggested a change to this sentence about the member rate here.',
  '',
  'A paragraph with a resolved thread on it.',
  '',
  '| Column | Value |',
  '| --- | ---: |',
  '| Alpha | 1 |',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '<div class="note">Raw HTML block</div>',
  '',
  'A text that will be deleted so its thread detaches.',
  '',
  'The closing paragraph has a question from Claude.',
  '',
].join('\n')

async function seed(cli: CliHelper): Promise<void> {
  const ops: AgentOp[] = [
    { op: 'comment', quote: 'first comment from TJ', body: 'Placeholder until TJ’s own comment lands.' },
    { op: 'suggest', quote: 'the member rate here', replace: 'the member rate', reason: 'Tighter.' },
    { op: 'comment', quote: 'a resolved thread', body: 'Done with this one.' },
    { op: 'comment', quote: 'will be deleted', body: 'This one loses its text.' },
    { op: 'comment', quote: 'a question from Claude', body: 'Should this say “net returns”?' },
    { op: 'comment', doc: true, body: 'Overall: reads well.' },
  ]
  const r = await cli.batch(FILE, { ops })
  expect(r.ok, r.stdout + r.stderr).toBe(true)
  const res = JSON.parse(r.stdout) as { rev: number; results: Array<{ thread?: string }> }
  const resolved = res.results[2]!.thread!
  const r2 = await cli.batch(FILE, { ops: [{ op: 'resolve', thread: resolved as never }] })
  expect(r2.ok, r2.stdout + r2.stderr).toBe(true)
  // delete the detached thread's text, so it lands in the Detached list with its original quote
  const r3 = await cli.batch(FILE, { ops: [{ op: 'write', markdown: DOC.replace('A text that will be deleted so its thread detaches.\n\n', ''), baseRev: res.rev }] })
  expect(r3.ok, r3.stdout + r3.stderr).toBe(true)
}

async function allStates(page: Page, o: { context: BrowserContext; port: number; cli: CliHelper; webClient: WebClient }): Promise<void> {
  // show resolved threads, then the states only the session can raise
  await openRailSettings(page)
  await page.locator(sel('showResolved')).click()
  if (P3_SERVER_KIND === 'fake') {
    await fakeEmit(page, { save: { state: 'conflict', count: 1 } })
    await fakeEmit(page, { notice: { kind: 'warn', code: 'SUGGEST_MODE_BLOCKED', text: 'Code blocks can’t be tracked in Suggesting mode.' } })
    await fakeEmit(page, { banner: { kind: 'tab-not-leader' } })
    await fakeEmit(page, { activity: { file: FILE, state: 'replied', since: new Date().toISOString(), unreadFromClaude: 2 } })
  } else {
    // a toast and the badge: Send with no waiter copies the prompt; then Claude comments, so the badge offers
    // "Claude replied". (QA3: Send on a doc with nothing new says so and sends nothing, so the reviewer leaves a note first.)
    await o.webClient.createThread({ kind: 'doc' }, 'A note for Claude.')
    await page.locator(sel('send')).click()
    await expect(page.locator(sel('toast', { 'data-code': 'HANDOFF_COPIED' }))).toBeVisible()
    const r = await o.cli.batch(FILE, { ops: [{ op: 'comment', quote: 'The opening paragraph', body: 'Claude answers after the send.' }] })
    expect(r.ok, r.stdout + r.stderr).toBe(true)
    await expect(page.locator(sel('claudeBadge'))).toHaveAttribute('data-state', 'replied')
    // a banner and the save chip in a warning state: a second tab takes the doc over
    const other = await o.context.newPage()
    await openEditor(other, { port: o.port, file: FILE })
    const take = other.locator(sel('bannerAction', { 'data-action': 'take-over' }))
    await expect(take).toBeVisible()
    await take.click()
    await expect(page.locator(sel('banner', { 'data-kind': 'tab-not-leader' }))).toBeVisible()
    await expect(page.locator(sel('saveChip'))).toHaveAttribute('data-state', 'readonly')
  }
  await railSettled(page)
}

/**
 * P2-owned nodes axe flags on the real build, set aside by rule and markup. Empty since QA round 3: the "1." button,
 * the frontmatter line, the raw block and the status chip are named by what they show now (WCAG 2.5.3), so any
 * serious finding fails.
 */
const P2_KNOWN: ReadonlyArray<{ rule: string; what: string; html: RegExp }> = []

async function axe(page: Page, label: string): Promise<void> {
  // the fake editor's contenteditable stand-in has no accessible name; P2's editor names its root (the real build is
  // checked as-is)
  if (P3_SERVER_KIND === 'fake') await page.evaluate(() => document.querySelector('.mdr-fake-editor')?.setAttribute('aria-label', 'Document'))
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const setAside: string[] = []
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      ...v,
      nodes: v.nodes.filter((n) => {
        const known = P2_KNOWN.find((k) => k.rule === v.id && k.html.test(n.html))
        if (known) setAside.push(`${v.id}: ${known.what}`)
        return !known
      }),
    }))
    .filter((v) => v.nodes.length > 0)
  for (const d of new Set(setAside)) test.info().annotations.push({ type: 'p2-known-a11y', description: `${label}: ${d}` })
  const report = bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 5).map((n) => `  ${n.target.join(' ')} — ${n.failureSummary?.split('\n').join(' ')}`).join('\n')}`).join('\n')
  expect(bad, `${label}\n${report}`).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test(`axe: zero serious violations over every state (${scheme})`, async ({ page, context, server, tmpRoot, cli, webClient }) => {
    tmpRoot.write(FILE, DOC)
    await seed(cli)
    await installClipboard(page)
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await openEditor(page, { port: server.port, file: FILE })
    await expect(page.locator(sel('card')).first()).toBeVisible()
    await allStates(page, { context, port: server.port, cli, webClient })
    await axe(page, `${scheme}: main view`)

    // the history panel over the page
    await page.locator(sel('historyButton')).click()
    await expect(page.locator(sel('historyPanel'))).toBeVisible()
    await expect(page.locator(sel('historyVersion')).first()).toBeVisible()
    await axe(page, `${scheme}: history panel`)
    await page.keyboard.press('Escape')

    // the narrow sheet, open on a thread
    await page.setViewportSize({ width: 600, height: 900 })
    await expect(page.locator(sel('sheet'))).toBeVisible()
    await page.locator(sel('sheetToggle')).click()
    await expect(page.locator(sel('sheet'))).toHaveAttribute('data-open', 'true')
    await axe(page, `${scheme}: narrow sheet`)
  })
}

test('keyboard only: open, comment, reply, next/prev, toggle mode, accept, send', async ({ page, server, tmpRoot, cli, webClient }) => {
  tmpRoot.write(FILE, DOC)
  await seed(cli)
  await installClipboard(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEditor(page, { port: server.port, file: FILE })
  await expect(page.locator(sel('card')).first()).toBeVisible()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

  // comment: a selection in the editor, then Cmd+Opt+M opens a focused composer; Cmd+Enter posts
  await selectText(page, { from: 'closing paragraph' })
  await page.keyboard.press(`${mod}+Alt+KeyM`)
  await expect(page.locator(`${sel('cardReply')}:focus`)).toHaveCount(1)
  await page.keyboard.type('Keyboard comment.')
  await page.keyboard.press(`${mod}+Enter`)
  await expect(page.locator(sel('message')).filter({ hasText: 'Keyboard comment.' })).toHaveCount(1)

  // next / prev move between cards and focus them
  await page.keyboard.press(`${mod}+Alt+BracketRight`)
  await expect(page.locator(`${sel('card')}:focus`)).toHaveCount(1)
  const first = await page.locator(`${sel('card')}:focus`).getAttribute('data-thread')
  await page.keyboard.press(`${mod}+Alt+BracketRight`)
  await expect.poll(() => page.locator(`${sel('card')}:focus`).getAttribute('data-thread')).not.toBe(first)
  await page.keyboard.press(`${mod}+Alt+BracketLeft`)
  await expect.poll(() => page.locator(`${sel('card')}:focus`).getAttribute('data-thread')).toBe(first)

  // reply: Tab from the focused card reaches its reply box
  for (let i = 0; i < 8; i++) {
    if (await page.locator(`${sel('cardReply')}:focus`).count()) break
    await page.keyboard.press('Tab')
  }
  await expect(page.locator(`${sel('cardReply')}:focus`)).toHaveCount(1)
  await page.keyboard.type('Keyboard reply.')
  await page.keyboard.press(`${mod}+Enter`)
  await expect(page.locator(sel('message')).filter({ hasText: 'Keyboard reply.' })).toHaveCount(1)

  // toggle mode: P2's shortcut with the real editor; the mode pill (a button) on the fakes
  if (P3_SERVER_KIND === 'fake') {
    await page.locator(sel('modePill')).focus()
    await page.keyboard.press('Enter')
  } else {
    await page.locator(sel('editor')).focus()
    await page.keyboard.press(`${mod}+Alt+Shift+KeyX`)
  }
  await expect(page.locator('#mdr-app')).toHaveAttribute('data-mode', 'suggesting')

  // accept: focus the suggestion row, Cmd+Opt+A
  const item = page.locator(sel('suggestionItem')).first()
  const sid = await item.getAttribute('data-suggestion')
  await item.locator(sel('accept')).focus()
  await page.keyboard.press(`${mod}+Alt+KeyA`)
  await expect.poll(async () => (await webClient.review()).suggestions.find((x) => x.id === sid)?.status, { timeout: 10_000 }).toBe('accepted')

  // send: Cmd+Shift+Enter anywhere
  await page.keyboard.press(`${mod}+Shift+Enter`)
  await expect(page.locator(`${sel('toast')}:not([data-code="HANDOFF_HINT"])`).filter({ hasText: /Claude|prompt|message/i }).first()).toBeVisible()
})
