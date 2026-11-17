// tests/e2e/p2-fidelity-browser.spec.ts (P2; CONTRACTS §12.0.4, §3.4 G0/G4/G6, §1.3 corpus row, FINDINGS caveat 5). The
// real-Chromium half of the fidelity gates, over every file in tests/fixtures/docs/ and
// tests/corpus/fixtures/{synthetic,real}/ (real skipped with a note when absent; the QA gate needs it). For each file,
// open it in the built app, await settled(), then:
//   1. blocks() equals the server snapshot's blocks on (hash, start, end, fidelity)            (G6 in Chromium)
//   2. ptext() equals ptextOf(load(md, text).doc, L) computed here through core/ on jsdom        (G4 in Chromium)
//   3. planSave() is [] with no input: view plugins and the status-header decoration save nothing (G0 no-op)
//   4. a real click into the middle of a seeded-random paragraph, one typed word, Saved: the file on disk differs
//      from the original only inside that paragraph's source lines (one-word-edit QA row)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import '../helpers/setup-node-dom'
import { ptextOf } from '../../core/ptext'
import { load } from '../../core/splice/load'
import { sharedMd } from '../fakes/FakeDocStore'
import { browserChoice } from '../helpers/browser'
import { openEditor } from '../helpers/openEditor'
import { FIXTURES_DIR } from '../fixtures/index'
import { REPO_ROOT } from '../helpers/tmpRoot'
import { diffConfinedTo, saveState, serverDoc } from './fixtures/p2'
import { expect, test } from './fixtures'

const BROWSER = browserChoice()
test.use({ serverKind: 'real', fixtureFiles: [] })
test.skip(!BROWSER.available, BROWSER.reason)

const CORPUS = join(REPO_ROOT, 'tests', 'corpus', 'fixtures')
const mdFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [])
const SETS: Array<{ set: string; dir: string; files: string[] }> = [
  { set: 'docs', dir: FIXTURES_DIR, files: mdFiles(FIXTURES_DIR) },
  { set: 'synthetic', dir: join(CORPUS, 'synthetic'), files: mdFiles(join(CORPUS, 'synthetic')) },
  { set: 'real', dir: join(CORPUS, 'real'), files: mdFiles(join(CORPUS, 'real')) },
]

/** Deterministic per-file choice (FNV-1a), so a failure reproduces. */
function seed(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

const WORD = 'zqxv'

test('p2-fidelity-browser: corpus sets present', () => {
  const real = SETS.find((s) => s.set === 'real')!
  test.info().annotations.push({ type: 'corpus', description: SETS.map((s) => `${s.set}: ${s.files.length}`).join(', ') })
  if (real.files.length === 0) {
    test.info().annotations.push({ type: 'real', description: 'skipped (run scripts/build-corpus.py); the QA gate needs it' })
  }
  expect(SETS[0]!.files.length).toBeGreaterThan(0)
})

for (const { set, dir, files } of SETS) {
  test.describe(set, () => {
    for (const name of files) {
      test(`p2-fidelity-browser: ${set}/${name}`, async ({ page, server, tmpRoot }) => {
        const file = set === 'docs' ? name : `${set}__${name}`
        const bytes = readFileSync(join(dir, name))
        tmpRoot.write(file, bytes)
        const original = tmpRoot.read(file)
        const text = original.startsWith('﻿') ? original.slice(1) : original
        const ed = await openEditor(page, { port: server.port, file })
        await ed.settled()
        const snap = await serverDoc(server, file)
        expect(snap.readOnly).toBe(false)
        expect(snap.markdown).toBe(text)

        // 1. G6: the browser's block map equals the server's
        const pick = (b: { hash: string; start: number; end: number; fidelity: string }) => ({ hash: b.hash, start: b.start, end: b.end, fidelity: b.fidelity })
        const browserBlocks = await ed.debug.blocks()
        expect(browserBlocks.map(pick)).toEqual(snap.blocks.map(pick))

        // 2. G4: the browser's ptext equals core's on jsdom
        const md = await sharedMd()
        const L = load(md, text)
        const p = ptextOf(L.doc, L)
        const live = await ed.debug.ptext()
        expect(live.text).toBe(p.text)
        expect(live.blockRanges).toEqual(p.blockRanges)

        // 3. G0: opening saves nothing
        expect(await ed.debug.planSave()).toEqual([])

        // 4. one word typed with the real keyboard into a seeded-random top-level paragraph
        const target = await page.evaluate((k) => {
          const pm = document.querySelector<HTMLElement>('#mdr-editor-host .ProseMirror')!
          const words: Array<{ node: Text; at: number; len: number }> = []
          const paras = [...pm.children].filter((el): el is HTMLParagraphElement =>
            el instanceof HTMLParagraphElement && !el.closest('.mdr-status-block.is-collapsed') && el.isContentEditable)
          const candidates = paras.filter((el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && /[A-Za-z]{4,}/.test(n.textContent ?? '')))
          if (candidates.length === 0) return null
          const el = candidates[k % candidates.length]!
          for (const n of el.childNodes) {
            if (n.nodeType !== Node.TEXT_NODE) continue
            for (const m of (n.textContent ?? '').matchAll(/[A-Za-z]{4,}/g)) words.push({ node: n as Text, at: m.index!, len: m[0].length })
          }
          const w = words[Math.floor(words.length / 2)]!
          el.scrollIntoView({ block: 'center' })
          const r = document.createRange()
          r.setStart(w.node, w.at)
          r.setEnd(w.node, w.at + w.len)
          const box = r.getBoundingClientRect()
          return { x: box.left + box.width / 2, y: box.top + box.height / 2, word: w.node.data.slice(w.at, w.at + w.len) }
        }, seed(name))
        if (!target) {
          test.info().annotations.push({ type: 'one-word-edit', description: 'skipped: no editable top-level paragraph' })
          return
        }
        await page.mouse.click(target.x, target.y)
        await page.waitForTimeout(60)
        const at = await ed.bridge((b) => b.getSelectionTarget({ collapsed: 'word' }))
        expect(at?.kind, `no word target at "${target.word}"`).toBe('anchor')
        if (at?.kind !== 'anchor') return
        const block = browserBlocks[at.anchor.hint.block]!
        expect(block.hash).toBe(at.anchor.hint.blockHash)
        expect(block.mdType).toBe('paragraph')
        await page.keyboard.type(` ${WORD}`)
        await ed.session((s) => s.flush())
        await expect.poll(() => saveState(ed)).toBe('saved')
        const after = tmpRoot.read(file)
        expect(after).not.toBe(original)
        expect(after.split(WORD).length).toBe(2)
        // the edit stays inside the paragraph's source lines (BlockInfo lines are 1-based, inclusive)
        expect(diffConfinedTo(original, after, block.line - 1, block.endLine - 1), `diff escapes lines ${block.line}-${block.endLine}`).toBe(true)
        const lines = after.split('\n')
        const hit = lines.findIndex((l) => l.includes(WORD))
        expect(hit).toBeGreaterThanOrEqual(block.line - 1)
        expect(await ed.debug.planSave()).toEqual([])
      })
    }
  })
}
