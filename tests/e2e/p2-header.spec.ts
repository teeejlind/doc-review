// tests/e2e/p2-header.spec.ts (P2; CONTRACTS §12.12, §12.15). Real browser on the day-0 harness page.
// Body status block: the collapsed chip shows the status and its phrases; typing while collapsed changes nothing;
// expand, edit one phrase, save → only that line changes on disk; a Suggesting-mode edit is tracked with the chip
// forced open; a comment on the status text anchors and follows an edit; an external rewrite of the status line
// updates the chip within 1 s.
// YAML panel: status chip; a plain-field edit, a quoted-field edit and an added key each change one line; Edit YAML on
// a block-scalar field changes only the edited lines; a round trip with no edit is byte-identical; the Suggesting-mode
// block.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TextAnchor } from '../../shared/types'
import { TEST_ACTIONS } from '../../shared/constants'
import { browserChoice } from '../helpers/browser'
import { captureNotices, changedLines, notices, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const FILE = 'status.md'
const STATUS_DOC = '# Composting explained\n\n**Status:** draft only · needs legal review\n**Owner:** TJ\n\nNext paragraph.\n'
const fixture = (name: string): string => readFileSync(join(process.cwd(), 'tests/fixtures/docs', name), 'utf8')

test('p2-header: the collapsed chip; read-only while collapsed; expand and edit one phrase', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: STATUS_DOC })
  const chip = ed.testid('statusChip')
  await expect(chip).toHaveAttribute('data-expanded', 'false')
  await expect(chip.locator('.mdr-status-chip__pill')).toHaveText(['draft only', 'needs legal review'])
  await expect(chip.locator('.mdr-status-chip__meta')).toHaveText('Owner: TJ')
  await expect(page.locator('#mdr-editor-host .mdr-status-block.is-collapsed')).toBeHidden()

  // typing while collapsed changes nothing: Backspace at the next block would join into it
  await placeCaret(page, 'Next paragraph.', 'start')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  expect(await savedText(ed, tmpRoot, FILE)).toBe(STATUS_DOC)

  // expand by clicking the chip, edit one phrase: only that line changes
  await chip.click()
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  await placeCaret(page, 'draft only')
  await page.keyboard.type(' (v2)')
  const out = await savedText(ed, tmpRoot, FILE)
  expect(changedLines(STATUS_DOC, out)).toEqual([2])
  expect(out.split('\n')[2]).toBe('**Status:** draft only (v2) · needs legal review')
  // the caret leaves: collapsed again, with the new phrase
  await placeCaret(page, 'Next paragraph.')
  await expect(chip).toHaveAttribute('data-expanded', 'false')
  await expect(chip.locator('.mdr-status-chip__pill')).toHaveText(['draft only (v2)', 'needs legal review'])
})

test('p2-header: moving the caret into the collapsed block by keyboard expands it', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: STATUS_DOC })
  const chip = ed.testid('statusChip')
  await placeCaret(page, 'Composting explained')
  await page.keyboard.press('ArrowDown')
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  await page.keyboard.type('X')
  // the caret at the start of a bold run types bold (ProseMirror's mark inheritance)
  expect((await savedText(ed, tmpRoot, FILE)).split('\n')[2]).toBe('**XStatus:** draft only · needs legal review')
  // and from below: ArrowUp at the start of the next block lands at the block's end
  await placeCaret(page, 'Next paragraph.')
  await expect(chip).toHaveAttribute('data-expanded', 'false')
  await placeCaret(page, 'Next paragraph.', 'start')
  await page.keyboard.press('ArrowUp')
  await expect(chip).toHaveAttribute('data-expanded', 'true')
})

test('p2-header: a Suggesting-mode edit is tracked with the chip forced open', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: STATUS_DOC })
  await ed.testid('modePill').click()
  await ed.testid('statusChip').click()
  await placeCaret(page, 'review')
  await page.keyboard.type('!')
  await placeCaret(page, 'Next paragraph.')
  await expect(ed.testid('statusChip')).toHaveAttribute('data-expanded', 'true')
  await expect(ed.testid('suggestion', { 'data-kind': 'ins' }).first()).toBeVisible()
  expect(await savedText(ed, tmpRoot, FILE)).toBe(STATUS_DOC)
})

test('p2-header: a comment on the status text anchors and follows an edit; an external rewrite updates the chip within 1 s', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: FILE, content: STATUS_DOC })
  await ed.testid('statusChip').click()
  await placeCaret(page, 'needs legal review', 'select')
  const target = await ed.bridge((b) => b.getSelectionTarget())
  expect(target?.kind).toBe('anchor')
  const created = await ed.session((s, a) => s.createThread(a, 'Which lane is this?'), (target as { anchor: TextAnchor }).anchor)
  const tid = (created as { thread: { id: string } }).thread.id
  const hl = ed.testid('highlight', { 'data-thread': tid })
  await expect(hl).toHaveText('needs legal review')
  // an edit before the quote in the same block: the highlight follows it
  await placeCaret(page, 'draft only')
  await page.keyboard.type(' (v2)')
  await savedText(ed, tmpRoot, FILE)
  await expect(hl).toHaveText('needs legal review')
  const t = await ed.session((s, id) => s.getReview().threads.find((x) => x.id === id), tid)
  expect(t?.detached).toBeFalsy()
  // resolve it, then rewrite the status line on disk (as Claude would): the chip follows within 1 s
  await ed.session((s, id) => s.resolve(id as never), tid)
  await placeCaret(page, 'Next paragraph.')
  const current = tmpRoot.read(FILE)
  tmpRoot.write(FILE, current.replace(/\*\*Status:\*\* [^\n]*/, '**Status:** approved per approvals/x.md (hash-matched)'))
  await expect(ed.testid('statusChip').locator('.mdr-status-chip__pill')).toHaveText(['approved per approvals/x.md (hash-matched)'], { timeout: 1_000 })
})

test.describe('YAML panel', () => {
  const F = 'syn__frontmatter-complex.md'

  test('p2-header: status chip; plain, quoted and added fields each change one line; round trip with no edit', async ({ page, server, tmpRoot }) => {
    const original = fixture(F)
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: F, content: original })
    const panel = ed.testid('frontmatterPanel')
    await expect(panel).toHaveAttribute('data-expanded', 'false')
    await expect(ed.testid('frontmatterStatus')).toHaveText('draft only · needs legal review')
    // expand / collapse / expand with no edit: byte-identical
    await panel.locator('.mdr-frontmatter__line').click()
    await panel.locator('.mdr-frontmatter__line').click()
    await panel.locator('.mdr-frontmatter__line').click()
    await expect(panel).toHaveAttribute('data-expanded', 'true')
    expect(await ed.debug.planSave()).toEqual([])
    expect(await savedText(ed, tmpRoot, F)).toBe(original)

    const value = (key: string): import('@playwright/test').Locator => ed.testid('frontmatterField', { 'data-key': key }).locator('input')
    await value('owner').fill('Jordan')
    await value('owner').press('Enter')
    let out = await savedText(ed, tmpRoot, F)
    expect(changedLines(original, out)).toEqual([3])
    const afterPlain = out
    await value('title').fill('New: title')
    await value('title').press('Enter')
    out = await savedText(ed, tmpRoot, F)
    expect(changedLines(afterPlain, out)).toEqual([2])
    expect(out.split('\n')[2]).toBe('title: "New: title"')
    const afterQuoted = out
    const [newKey, newValue] = TEST_ACTIONS.frontmatterNewField
    await panel.locator(`[data-field="${newKey}"]`).fill('lane')
    await panel.locator(`[data-field="${newValue}"]`).fill('PS')
    await ed.testid('frontmatterAdd').click()
    out = await savedText(ed, tmpRoot, F)
    expect(out.split('\n').length).toBe(afterQuoted.split('\n').length + 1)
    expect(out).toContain('\nempty:\nlane: PS\n---\n')
    await expect(ed.testid('frontmatterField', { 'data-key': 'lane' })).toHaveAttribute('data-kind', 'plain')
  })

  test('p2-header: Edit YAML on a block-scalar field changes only the edited lines; the Suggesting-mode block', async ({ page, server, tmpRoot }) => {
    const original = fixture(F)
    const ed = await openDoc(page, { port: server.port, tmpRoot, file: F, content: original })
    await captureNotices(ed)
    const panel = ed.testid('frontmatterPanel')
    await panel.locator('.mdr-frontmatter__line').click()
    await expect(ed.testid('frontmatterField', { 'data-key': 'summary' })).toHaveAttribute('data-kind', 'multiline')
    await ed.testid('frontmatterField', { 'data-key': 'summary' }).locator('[data-testid="mdr-edit-yaml"]').click()
    const pop = ed.testid('yamlPopover')
    const yaml = pop.locator('[data-testid="mdr-popover-field"][data-field="yaml"]')
    await yaml.fill((await yaml.inputValue()).replace('  summary text.', '  summary text, revised.'))
    await pop.locator('[data-testid="mdr-popover-action"][data-action="save"]').click()
    const out = await savedText(ed, tmpRoot, F)
    expect(changedLines(original, out)).toEqual([9])

    // Suggesting mode: focusing a field raises the notice; field edits change nothing
    await ed.testid('modePill').click()
    await ed.testid('frontmatterField', { 'data-key': 'owner' }).locator('input').click()
    expect(await notices(page)).toContain('SUGGEST_MODE_BLOCKED')
    await page.keyboard.type('zzz')
    await page.keyboard.press('Enter')
    expect(await savedText(ed, tmpRoot, F)).toBe(out)
  })
})
