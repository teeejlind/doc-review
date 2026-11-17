// tests/e2e/t2-editor-ux-images.spec.ts (T2 editor-ux): Pass 4 #28, images that sit beside the markdown file.
// `![x](./local.png)` loads through GET /api/asset in the view; the saved markdown keeps the src as written.
import type { Page } from '@playwright/test'
import { browserChoice } from '../helpers/browser'
import { makePng } from '../helpers/png'
import { openDoc, placeCaret, savedText } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const PNG = makePng(3, 2)

const DOC = [
  '# Pictures',
  '',
  'Intro line before the pictures.',
  '',
  '![local](./local.png)',
  '',
  '![deeper alt text](./images/pic.png "A title")',
  '',
  '![up](../shared/up.png)',
  '',
  '![spaced](./my%20pic.png)',
  '',
  'Closing line.',
  '',
].join('\n')

const loaded = (page: Page): Promise<Array<{ alt: string; ok: boolean; w: number; src: string }>> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('#mdr-editor-host .ProseMirror img:not(.ProseMirror-separator)')].map((i) => ({
      alt: i.alt, ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, src: i.getAttribute('src') ?? '',
    })),
  )

test('#28: images beside the document show, with no 404s, and the saved markdown is untouched', async ({ page, server, tmpRoot }) => {
  tmpRoot.write('notes/local.png', PNG)
  tmpRoot.write('notes/images/pic.png', PNG)
  tmpRoot.write('shared/up.png', PNG)
  tmpRoot.write('notes/my pic.png', PNG)
  const bad: string[] = []
  page.on('response', (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`)
  })
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'notes/doc.md', content: DOC })
  await expect.poll(async () => (await loaded(page)).filter((i) => i.ok).length).toBe(4)
  expect((await loaded(page)).map((i) => [i.alt, i.w])).toEqual([['local', 3], ['deeper alt text', 3], ['up', 3], ['spaced', 3]])
  expect(bad).toEqual([])
  // the view's URL is never what is saved or what the editor holds
  expect(await ed.debug.liveMarkdown()).toBe(DOC)
  await placeCaret(page, 'Closing line.', 'end')
  await page.keyboard.type(' Edited.')
  expect(await savedText(ed, tmpRoot, 'notes/doc.md')).toBe(DOC.replace('Closing line.', 'Closing line. Edited.'))
  expect(tmpRoot.readBytes('notes/local.png').equals(PNG)).toBe(true)
})

test('#28: a doc at the root of the served folder, and a picture that is not there, do no harm', async ({ page, server, tmpRoot }) => {
  tmpRoot.write('pic.png', PNG)
  const md = 'Top doc.\n\n![here](pic.png)\n\n![gone](missing.png)\n\n![out](../../outside.png)\n\nEnd.\n'
  const seen: Array<{ status: number; path: string }> = []
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/asset') seen.push({ status: r.status(), path: new URL(r.url()).searchParams.get('path') ?? '' })
  })
  const ed = await openDoc(page, { port: server.port, tmpRoot, file: 'top.md', content: md })
  await expect.poll(async () => (await loaded(page)).find((i) => i.alt === 'here')?.ok).toBe(true)
  await expect.poll(() => seen.length).toBe(3)
  expect(seen.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { status: 403, path: '../../outside.png' },
    { status: 404, path: 'missing.png' },
    { status: 200, path: 'pic.png' },
  ])
  expect((await loaded(page)).filter((i) => i.ok).map((i) => i.alt)).toEqual(['here'])
  expect(await savedText(ed, tmpRoot, 'top.md')).toBe(md)
})

test('#28: the image URL needs the page\'s token', async ({ page, server, tmpRoot }) => {
  tmpRoot.write('pic.png', PNG)
  await openDoc(page, { port: server.port, tmpRoot, file: 'top.md', content: '![here](pic.png)\n' })
  const src = (await loaded(page))[0]!.src
  expect(src).toMatch(/^\/api\/asset\?file=top\.md&path=pic\.png&t=/)
  const ok = await fetch(`${server.origin}${src}`)
  expect(ok.status).toBe(200)
  expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true)
  const noToken = await fetch(`${server.origin}${src.replace(/&t=.*$/, '')}`)
  expect(noToken.status).toBe(401)
})
