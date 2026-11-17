// tests/e2e/qa2-e-atoms.spec.ts (QA round 2, agent E: unverified #4). Caret movement plus one key must not be able to
// node-select and destroy the collapsed frontmatter panel or a raw HTML block (their contents are hidden in the
// collapsed view). Deleting them stays possible, through a deliberate step.
import { browserChoice } from '../helpers/browser'
import { openDoc, placeCaret, saveState } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const FM = '---\ntitle: Simple frontmatter\nstatus: draft only\nowner: TJ\n---\n\n# Body heading\n\nFirst paragraph.\n'
const HTML = '# Block HTML\n\n<div class="callout">\n  <p>Raw block HTML stays byte-exact.</p>\n</div>\n\nText after the HTML.\n'

test('qa2-e #4: two Backspaces at the start of the first block leave the frontmatter alone', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'fm1.md', content: FM })
  await placeCaret(page, 'Body heading', 'start')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  await ed.session((s) => s.flush())
  await expect(ed.testid('frontmatterPanel')).toHaveCount(1)
  expect(await ed.debug.liveMarkdown()).toBe(FM)
  expect(tmpRoot.read('fm1.md')).toBe(FM)
})

test('qa2-e #4: ArrowUp into the frontmatter, then typing, does not replace it', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'fm2.md', content: FM })
  await placeCaret(page, 'Body heading', 'start')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('Zed', { delay: 10 })
  await page.waitForTimeout(250)
  await ed.session((s) => s.flush())
  await expect(ed.testid('frontmatterPanel')).toHaveCount(1)
  expect(await ed.debug.liveMarkdown()).toBe(FM)
  expect(tmpRoot.read('fm2.md')).toBe(FM)
})

test('qa2-e #4: two Backspaces at the start of the paragraph after a raw HTML block leave it alone', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'html1.md', content: HTML })
  await expect(ed.testid('rawBlock')).toHaveCount(1)
  await placeCaret(page, 'Text after the HTML', 'start')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  await ed.session((s) => s.flush())
  await expect(ed.testid('rawBlock')).toHaveCount(1)
  expect(await ed.debug.liveMarkdown()).toBe(HTML)
  expect(tmpRoot.read('html1.md')).toBe(HTML)
  await expect.poll(() => saveState(ed)).toBe('saved')
})

test('qa2-e #4: ArrowUp into a raw HTML block, then typing, does not replace it', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'html2.md', content: HTML })
  await placeCaret(page, 'Text after the HTML', 'start')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('Zed', { delay: 10 })
  await page.waitForTimeout(250)
  await ed.session((s) => s.flush())
  await expect(ed.testid('rawBlock')).toHaveCount(1)
  expect(await ed.debug.liveMarkdown()).toBe(HTML)
  expect(tmpRoot.read('html2.md')).toBe(HTML)
})

test('qa2-e #4: a deliberate removal still works: click the raw block, Cancel, Backspace; Cmd+Z brings it back', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'html3.md', content: HTML })
  await ed.testid('rawBlock').click()
  const pop = ed.testid('rawPopover')
  await expect(pop).toBeVisible()
  await pop.locator('[data-action="cancel"]').click()
  await expect(pop).toBeHidden()
  await page.keyboard.press('Backspace')
  await ed.session((s) => s.flush())
  await expect(ed.testid('rawBlock')).toHaveCount(0)
  expect(tmpRoot.read('html3.md')).toBe('# Block HTML\n\nText after the HTML.\n')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(ed.testid('rawBlock')).toHaveCount(1)
  expect(await ed.debug.liveMarkdown()).toBe(HTML)
})

test('qa2-e #4: the popover\'s empty Save still removes a raw block', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'html4.md', content: HTML })
  await ed.testid('rawBlock').click()
  const pop = ed.testid('rawPopover')
  await pop.locator('[data-field="source"]').fill('')
  await pop.locator('[data-action="save"]').click()
  await ed.session((s) => s.flush())
  await expect(ed.testid('rawBlock')).toHaveCount(0)
  expect(tmpRoot.read('html4.md')).toBe('# Block HTML\n\nText after the HTML.\n')
})

test('qa2-e #4 / QA3: on a fresh page the caret is in the first text, not on the frontmatter; typing never touches the panel', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'fm3.md', content: FM })
  await ed.bridge((b) => b.focusEditor())
  await page.keyboard.type('Zed', { delay: 10 })
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(250)
  await ed.session((s) => s.flush())
  await expect(ed.testid('frontmatterPanel')).toHaveCount(1)
  const out = await ed.debug.liveMarkdown()
  expect(out.slice(0, FM.indexOf('# '))).toBe(FM.slice(0, FM.indexOf('# ')))
  expect(out).toBe(FM.replace('# ', '# Ze'))
})
