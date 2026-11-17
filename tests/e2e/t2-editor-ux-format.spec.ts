// tests/e2e/t2-editor-ux-format.spec.ts (T2 editor-ux): Pass 4 #32 and #33 on the real keyboard and toolbar.
//   #32 Cmd+B / Cmd+I (or the B / I button) with the caret inside a word formats the whole word.
//   #33 on a selection that is partly bold, the first Cmd+B bolds all of it and the second takes it all off.
import type { Page } from '@playwright/test'
import { browserChoice } from '../helpers/browser'
import { MOD, openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const INTRO = 'Intro paragraph with some words in it.\n'
const MIXED = 'Some plain text then **bold part** and more plain text here.\n'

/** Select from the start of `from` to the end of `to` (two text nodes, so ProseMirror sees a range across a mark). */
async function selectAcross(page: Page, from: string, to: string): Promise<void> {
  await page.evaluate(([a, b]) => {
    const root = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
    root.focus()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let start: [Node, number] | null = null
    let end: [Node, number] | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.textContent ?? ''
      if (!start && s.includes(a!)) start = [n, s.indexOf(a!)]
      if (s.includes(b!)) end = [n, s.indexOf(b!) + b!.length]
    }
    getSelection()!.setBaseAndExtent(start![0], start![1], end![0], end![1])
  }, [from, to] as const)
  await page.waitForTimeout(80)
}

const button = (page: Page, action: string) => page.locator(`[data-testid="mdr-toolbar-button"][data-action="${action}"]`)

test('#32: Cmd+B with the caret in the middle of a word bolds the word, and again takes it off', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: INTRO })
  await placeCaret(page, 'parag', 'end')
  await page.keyboard.press(`${MOD}+KeyB`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Intro **paragraph** with some words in it.\n')
  await expect(button(page, 'bold')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(`${MOD}+KeyB`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe(INTRO)
  await expect(button(page, 'bold')).toHaveAttribute('aria-pressed', 'false')
})

test('#32: Cmd+I and the toolbar buttons do the same, and typing carries on from where the caret was', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: INTRO })
  await placeCaret(page, 'parag', 'end')
  await page.keyboard.press(`${MOD}+KeyI`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Intro *paragraph* with some words in it.\n')
  await button(page, 'bold').click()
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Intro ***paragraph*** with some words in it.\n')
  await page.keyboard.type('_')
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Intro ***parag_raph*** with some words in it.\n')
})

test('#32: at the edge of a word the mark still waits for what is typed next', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: INTRO })
  await placeCaret(page, 'Intro', 'end')
  await page.keyboard.press(`${MOD}+KeyB`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe(INTRO)
  await page.keyboard.type('ZZ')
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Intro**ZZ** paragraph with some words in it.\n')
})

test('#33: a partly bold selection: the first Cmd+B bolds all of it, the second takes it all off', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: MIXED })
  await selectAcross(page, 'plain text then ', 'and more')
  await expect(button(page, 'bold')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press(`${MOD}+KeyB`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Some **plain text then bold part and more** plain text here.\n')
  await expect(button(page, 'bold')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(`${MOD}+KeyB`)
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Some plain text then bold part and more plain text here.\n')
})

test('#33: the Bold button does the same on a mixed selection, and a Suggesting-mode press is one format suggestion', async ({ page, server, tmpRoot }) => {
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'k.md', content: MIXED })
  await ed.testid('modePill').click()
  await selectAcross(page, 'plain text then ', 'and more')
  await button(page, 'bold').click()
  await expect.poll(() => ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').length), { timeout: 15_000 }).toBe(1)
  const [id] = await ed.session((s) => s.getReview().suggestions.filter((x) => x.status === 'pending').map((x) => x.id))
  expect(await ed.bridge((b, sid) => b.accept(sid), id!)).toMatchObject({ ok: true })
  expect(await savedText(ed, tmpRoot, 'k.md')).toBe('Some **plain text then bold part and more** plain text here.\n')
})
