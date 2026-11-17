// tests/e2e/p1-fidelity.spec.ts (P1; CONTRACTS §14 P1 E2E, §3.1, §3.4 G0, D40, §13 rows 1, 2, 59).
//
// Server-side open/save is byte-identical over every committed fixture, the BOM and CRLF ones included, through the
// built server and webClient (no editor; the real-editor half is P2's p2-fidelity-browser):
// - GET /api/doc serves the decoded text (BOM stripped, EOLs untouched) whose BOM + UTF-8 bytes are exactly the file,
//   with `hash` = sha256 of the raw bytes (the doc-hash domain, D40) and the right bom/eol/size;
// - POST /api/save with no ops is `noop`: same rev and hash, the bytes untouched, nothing appended (no sidecar, no
//   .review/ history appears);
// - saveText(snapshot.markdown) plans no ops and is `noop` too;
// - an edit and its exact revert, both through POST /api/save, give back the original bytes (seams, EOLs, BOM and the
//   final-EOL state all survive a real write and a second one).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_DOCS, type FixtureDoc } from '../fixtures/index'
import type { SaveResponse } from '../../shared/types'
import { expect, sha256, test, P1_PORT_OFFSET } from './fixtures/p1'

/** The word edited in the edit + revert round trip where the default pick (`pickWord`) isn't the interesting one. */
const EDIT: Record<string, [from: string, to: string]> = {
  'basic.md': ['monthly', 'quarterly'],
  'syn__bom-crlf.md': ['Paragraph with', 'Paragraph using'],
  'syn__crlf.md': ['wraps', 'folds'],
  'syn__crlf-mixed.md': ['LF paragraph', 'LF section'],
  'syn__emoji-crlf-no-eol.md': ['Last line', 'Final line'],
}

/** The first word of 4+ ASCII letters on a body line that isn't markup (frontmatter skipped), else anywhere, or null. */
function pickWord(md: string): string | null {
  const fm = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1(\r?\n|$)/.exec(md)
  for (const line of (fm ? md.slice(fm[0].length) : md).split(/\r?\n|\r/)) {
    if (/^\s*(#|\||<|`|~|\[|---|\*\*\*)/.test(line)) continue
    const w = /(?<![\\&\w])[A-Za-z]{4,}\b/.exec(line)
    if (w) return w[0]
  }
  // a frontmatter-only doc: edit inside the frontmatter
  return /[A-Za-z]{4,}/.exec(md)?.[0] ?? null
}

for (const fx of FIXTURE_DOCS) {
  test.describe(`p1-fidelity ${fx.file}`, () => {
    test.use({ fixtureFiles: [fx.file], docFile: fx.file, portOffset: P1_PORT_OFFSET })

    test('open and a no-op save are byte-identical; nothing is recorded', async ({ webClient, tmpRoot }) => {
      const raw = tmpRoot.readBytes(fx.file)
      const snap = await webClient.doc()
      expectSnapshotMatchesBytes(fx, snap, raw)

      const empty = await webClient.save({
        base: { rev: snap.rev, hash: snap.hash, blockHashes: snap.blocks.map((b) => b.hash) },
        ops: [],
        cause: 'edit',
        allowPartial: true,
      })
      expect(empty).toMatchObject({ ok: true, applied: 'noop', rev: snap.rev, hash: snap.hash, conflicts: [], unsaveable: [] })

      const same = await webClient.saveText(snap.markdown)
      expect(same).toMatchObject({ applied: 'noop', rev: snap.rev, hash: snap.hash })

      expect(tmpRoot.readBytes(fx.file).equals(raw), 'bytes unchanged').toBe(true)
      expect(tmpRoot.exists(`${fx.file}.review.jsonl`), 'no sidecar for a no-op').toBe(false)
      expect(existsSync(join(tmpRoot.root, '.review', 'history')), 'no history for a no-op').toBe(false)
      const again = await webClient.doc()
      expect({ rev: again.rev, hash: again.hash, markdown: again.markdown }).toEqual({ rev: snap.rev, hash: snap.hash, markdown: snap.markdown })
    })

    test('an edit and its revert give back the original bytes', async ({ webClient, tmpRoot }) => {
      const raw = tmpRoot.readBytes(fx.file)
      const snap = await webClient.doc()
      const pair = EDIT[fx.file]
      let from: string
      let to: string
      if (pair) [from, to] = pair
      else {
        const w = pickWord(snap.markdown)
        test.skip(w === null, 'no plain paragraph word to edit in this fixture')
        from = w!
        to = `${w!}x`
      }
      expect(snap.markdown).toContain(from)
      const edited = snap.markdown.replace(from, to)

      const r1: SaveResponse = await webClient.saveText(edited)
      expect(r1).toMatchObject({ applied: 'direct', conflicts: [], unsaveable: [] })
      const afterEdit = tmpRoot.readBytes(fx.file)
      expect(afterEdit.toString('utf8')).toBe((fx.bom ? '﻿' : '') + edited)
      expect(r1.hash).toBe(sha256(afterEdit))

      const r2 = await webClient.saveText(snap.markdown)
      expect(r2).toMatchObject({ applied: 'direct', conflicts: [], unsaveable: [] })
      const back = tmpRoot.readBytes(fx.file)
      expect(back.equals(raw), `bytes after the revert:\n${JSON.stringify(back.toString('utf8'))}\nwant:\n${JSON.stringify(raw.toString('utf8'))}`).toBe(true)
      expect(r2.hash).toBe(sha256(raw))
      expectSnapshotMatchesBytes(fx, await webClient.doc(), raw)
    })
  })
}

function expectSnapshotMatchesBytes(fx: FixtureDoc, snap: Awaited<ReturnType<import('../helpers/webClient').WebClient['doc']>>, raw: Buffer): void {
  expect(snap.file).toBe(fx.file)
  expect(snap.bom).toBe(fx.bom)
  expect(snap.markdown.startsWith('﻿')).toBe(false)
  expect(Buffer.from((snap.bom ? '﻿' : '') + snap.markdown, 'utf8').equals(raw), 'BOM + markdown is exactly the file').toBe(true)
  expect(snap.hash).toBe(sha256(raw))
  expect(snap.size).toBe(raw.length)
  expect(snap.readOnly).toBe(false)
  if (fx.eol === 'crlf') expect(snap.eol).toBe('\r\n')
  if (fx.eol === 'lf') expect(snap.eol).toBe('\n')
  // the block map tiles the text: offsets increase and stay inside it
  let last = 0
  for (const b of snap.blocks) {
    expect(b.start).toBeGreaterThanOrEqual(last)
    expect(b.end).toBeLessThanOrEqual(snap.markdown.length)
    last = b.end
  }
}
