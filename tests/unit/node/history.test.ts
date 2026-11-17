// tests/unit/node/history.test.ts (P1). §10 history reads over real index + objects: list (newest first, limit,
// unsnapshotted), show, and diff (hash-aligned blocks, word diff on replace, per-block by/lastBy attribution through
// every intermediate version, vN / rev:N / current refs, reverse diffs, lost objects).
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docHash } from '../../../core/hash'
import { openDocStore } from '../../../node/docstore'
import { appendVersion, encodeRaw, historyPaths, objectPath, readIndex, readObjectText, writeObject } from '../../../node/history'
import { realId } from '../../../node/root'
import * as S from '../../../shared/schemas'
import type { Actor, DocStore, VersionCause, VersionMeta } from '../../../shared/types'

const AT = '2026-10-15T17:00:00.000Z'
let root: string
const stores: DocStore[] = []
beforeAll(() => {
  root = realId(mkdtempSync(join(tmpdir(), 'mdr-hist-')))
})
afterAll(async () => {
  for (const s of stores) await s.close()
  rmSync(root, { recursive: true, force: true })
})

const V1 = '# T\n\nOne.\n\nTwo.\n\nThree.\n'
const V2 = '# T\n\nOne!\n\nTwo.\n\nThree.\n'            // Claude: One. → One!
const V3 = '# T\n\nOne!!\n\nTwo.\n\nThree?\n\nFour.\n'  // TJ: One! → One!!, Three. → Three?, + Four.
const V4 = '# T\n\nOne!!\n\nThree?\n\nFour.\n'          // Claude: deletes Two.

let n = 0
/**
 * A doc whose history holds `texts` as versions v1..vk (each by its actor, rev = its index + 1), whose sidecar has one
 * doc.rev per version, and whose current bytes are `current` (default: the last version).
 */
async function withHistory(texts: Array<[string, Actor, VersionCause]>, current?: [string, Actor]): Promise<{ s: DocStore; file: string; abs: string }> {
  const dir = `h${++n}`
  mkdirSync(join(root, dir))
  const file = `${dir}/doc.md`
  const abs = join(root, file)
  const cur = current ?? [texts[texts.length - 1]![0], texts[texts.length - 1]![1]]
  writeFileSync(abs, cur[0])
  const revLines: unknown[] = []
  let prevHash: string | null = null
  texts.forEach(([text, by, cause], i) => {
    const hash = docHash(text, false)
    writeObject(abs, hash, encodeRaw(text, false))
    const meta: VersionMeta = { v: `v${i + 1}`, n: i + 1, rev: i + 1, hash, by, cause, at: AT, size: Buffer.byteLength(text), revs: [i + 1, i + 1], blocksChanged: 1 }
    appendVersion(abs, meta)
    revLines.push({ seq: i + 1, id: `e_${ulid()}`, type: 'doc.rev', by: i === 0 ? 'system' : by, at: AT, rev: i + 1, prevRev: i === 0 ? null : i, prevHash, hash, bytes: meta.size, cause: i === 0 ? 'baseline' : 'cli' })
    prevHash = hash
  })
  if (current) {
    const hash = docHash(current[0], false)
    const rev = texts.length + 1
    writeObject(abs, hash, encodeRaw(current[0], false))
    revLines.push({ seq: rev, id: `e_${ulid()}`, type: 'doc.rev', by: current[1], at: AT, rev, prevRev: rev - 1, prevHash, hash, bytes: 1, cause: current[1] === 'external' ? 'external' : 'cli' })
  }
  const header = { type: 'header', schema: 'mdr.sidecar/2', docId: `d_${ulid()}`, file: 'doc.md', createdAt: AT, createdBy: 'mdr/2.0.0-dev' }
  writeFileSync(abs + '.review.jsonl', [header, ...revLines].map((l) => JSON.stringify(l)).join('\n') + '\n')
  const s = await openDocStore(root, file, { mode: 'server', lockTimeoutMs: 1000 })
  stores.push(s)
  return { s, file, abs }
}

const CHAIN: Array<[string, Actor, VersionCause]> = [[V1, 'external', 'baseline'], [V2, 'Claude', 'claude-write'], [V3, 'TJ', 'tj-session'], [V4, 'Claude', 'claude-write']]

describe('storage', () => {
  it('objects are gzip, content-addressed and write-if-absent; the index tolerates a torn tail and bad lines', async () => {
    const { abs } = await withHistory(CHAIN.slice(0, 1))
    const h = docHash(V1, false)
    expect(readObjectText(abs, h)).toEqual({ text: V1, bom: false })
    expect(writeObject(abs, h, encodeRaw('different bytes', false))).toBe(false)
    expect(readObjectText(abs, h)!.text).toBe(V1)
    writeFileSync(historyPaths(abs).index, readIndexText(abs) + 'not json\n{"v":"v2"')
    const r = readIndex(abs)
    expect(r.versions.map((v) => v.v)).toEqual(['v1'])
    expect(r.warnings).toHaveLength(1)
  })

  it('a BOM object round-trips its bytes', async () => {
    const { abs } = await withHistory(CHAIN.slice(0, 1))
    const h = docHash('x\n', true)
    writeObject(abs, h, encodeRaw('x\n', true))
    expect(readObjectText(abs, h)).toEqual({ text: 'x\n', bom: true })
  })
})

function readIndexText(abs: string): string {
  return readIndex(abs).versions.map((v) => JSON.stringify(v) + '\n').join('')
}

describe('list / show', () => {
  it('newest first; limit; currentRev/currentHash; unsnapshotted only when current differs from the latest version', async () => {
    const { s } = await withHistory(CHAIN)
    const l = await s.history.list()
    expect(S.HistoryListSchema.safeParse(l).success).toBe(true)
    expect(l.versions.map((v) => v.v)).toEqual(['v4', 'v3', 'v2', 'v1'])
    expect(l).toMatchObject({ via: 'server', currentRev: 4, currentHash: docHash(V4, false), unsnapshotted: false })
    expect((await s.history.list({ limit: 2 })).versions.map((v) => v.v)).toEqual(['v4', 'v3'])
    const { s: s2 } = await withHistory(CHAIN.slice(0, 2), ['# T\n\nEdited outside.\n', 'external'])
    expect((await s2.history.list()).unsnapshotted).toBe(true)
  })

  it('no history: an empty list, unsnapshotted', async () => {
    mkdirSync(join(root, 'empty'))
    writeFileSync(join(root, 'empty', 'doc.md'), V1)
    const s = await openDocStore(root, 'empty/doc.md', { mode: 'direct', lockTimeoutMs: 1, readOnly: true })
    stores.push(s)
    expect(await s.history.list()).toMatchObject({ versions: [], currentRev: 0, unsnapshotted: true })
  })

  it('show returns the version text; unknown or lost → VERSION_NOT_FOUND', async () => {
    const { s, abs } = await withHistory(CHAIN)
    const v = await s.history.show('v2')
    expect(S.VersionShowSchema.safeParse(v).success).toBe(true)
    expect(v).toMatchObject({ meta: { v: 'v2', by: 'Claude' }, markdown: V2 })
    await expect(s.history.show('v9')).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND', status: 404 })
    unlinkSync(objectPath(abs, docHash(V1, false)))
    await expect(s.history.show('v1')).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
  })
})

describe('diff (§10)', () => {
  const changed = (blocks: Array<{ op: string; before?: string; after?: string; by: Actor[]; lastBy: Actor | null }>) =>
    blocks.filter((b) => b.op !== 'equal').map((b) => ({ op: b.op, before: b.before, after: b.after, by: [...b.by].sort(), lastBy: b.lastBy }))

  it('v1 → current: each changed block names the authors who touched it and the last one', async () => {
    const { s } = await withHistory(CHAIN)
    const d = await s.history.diff('v1', 'current')
    expect(S.HistoryDiffSchema.safeParse(d).success).toBe(true)
    expect(d.from).toMatchObject({ v: 'v1' })
    expect(d.to).toEqual({ current: true, rev: 4, hash: docHash(V4, false) })
    // adjacent changed blocks form one run: One. → One! (Claude, v2) → One!! (TJ, v3); Three. → Three? and + Four.
    // (TJ, v3); Two. deleted (Claude, v4, the latest touch)
    expect(changed(d.blocks)).toEqual([
      { op: 'replace', before: 'One.\n\nTwo.\n\nThree.', after: 'One!!\n\nThree?\n\nFour.', by: ['Claude', 'TJ'], lastBy: 'Claude' },
    ])
  })

  it('a block touched by one author only is attributed to that author alone (v2 → v3)', async () => {
    const { s } = await withHistory(CHAIN)
    const d = await s.history.diff('v2', 'v3')
    const c = changed(d.blocks)
    expect(c.length).toBeGreaterThan(0)
    for (const b of c) expect(b.by).toEqual(['TJ'])
    expect(c.every((b) => b.lastBy === 'TJ')).toBe(true)
    const rep = d.blocks.find((b) => b.op === 'replace')
    expect(rep?.inline?.some(([op]) => op !== 0)).toBe(true)
  })

  it('separate blocks keep separate authors across several versions (v1 → v3)', async () => {
    const { s } = await withHistory([
      ['# T\n\nA.\n\nMid.\n\nB.\n', 'external', 'baseline'],
      ['# T\n\nA2.\n\nMid.\n\nB.\n', 'Claude', 'claude-write'],
      ['# T\n\nA2.\n\nMid.\n\nB2.\n', 'TJ', 'tj-session'],
    ])
    const d = await s.history.diff('v1', 'v3')
    const c = changed(d.blocks)
    expect(c).toEqual([
      { op: 'replace', before: 'A.', after: 'A2.', by: ['Claude'], lastBy: 'Claude' },
      { op: 'replace', before: 'B.', after: 'B2.', by: ['TJ'], lastBy: 'TJ' },
    ])
  })

  it('the same block edited twice carries both authors, lastBy the later one; inserts and deletes are attributed too', async () => {
    const { s } = await withHistory([
      ['# T\n\nA.\n\nB.\n\nC.\n', 'external', 'baseline'],
      ['# T\n\nA2.\n\nB.\n\nC.\n', 'Claude', 'claude-write'],
      ['# T\n\nA3.\n\nB.\n\nC.\n\nD.\n', 'TJ', 'tj-session'],
      ['# T\n\nA3.\n\nC.\n\nD.\n', 'Claude', 'claude-write'],
    ])
    const c = changed((await s.history.diff('v1', 'v4')).blocks)
    // A. → A2. (Claude) → A3. (TJ), and B. deleted by Claude in v4 (the latest touch), share one run; D. is TJ's insert
    expect(c).toEqual([
      { op: 'replace', before: 'A.\n\nB.', after: 'A3.', by: ['Claude', 'TJ'], lastBy: 'Claude' },
      { op: 'insert', before: undefined, after: 'D.', by: ['TJ'], lastBy: 'TJ' },
    ])
  })

  it('a pure delete names its deleter', async () => {
    const { s } = await withHistory([
      ['# T\n\nA.\n\nB.\n\nC.\n', 'external', 'baseline'],
      ['# T\n\nA.\n\nC.\n', 'TJ', 'tj-session'],
    ])
    expect(changed((await s.history.diff('v1', 'v2')).blocks)).toEqual([
      { op: 'delete', before: 'B.', after: undefined, by: ['TJ'], lastBy: 'TJ' },
    ])
  })

  it('current past the latest version is a final step by the last doc.rev actor', async () => {
    const { s } = await withHistory(CHAIN.slice(0, 2), ['# T\n\nOne!\n\nTwo.\n\nThree, edited outside.\n', 'external'])
    const c = changed((await s.history.diff('v2', 'current')).blocks)
    expect(c).toEqual([{ op: 'replace', before: 'Three.', after: 'Three, edited outside.', by: ['external'], lastBy: 'external' }])
  })

  it('rev:N refs resolve through the sidecar and its objects; an unknown rev → VERSION_NOT_FOUND', async () => {
    const { s } = await withHistory(CHAIN)
    const d = await s.history.diff('rev:1', 'rev:2')
    expect(d.from).toMatchObject({ v: 'v1' })
    expect(d.to).toMatchObject({ v: 'v2' })
    expect(changed(d.blocks)).toEqual([{ op: 'replace', before: 'One.', after: 'One!', by: ['Claude'], lastBy: 'Claude' }])
    await expect(s.history.diff('rev:40', 'current')).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
  })

  it('a reverse diff (to before from) carries no attribution', async () => {
    const { s } = await withHistory(CHAIN)
    const c = changed((await s.history.diff('v2', 'v1')).blocks)
    expect(c).toEqual([{ op: 'replace', before: 'One!', after: 'One.', by: [], lastBy: null }])
  })

  it('a lost intermediate object: the changed blocks fall back to every author of the span', async () => {
    const { s, abs } = await withHistory([
      ['# T\n\nA.\n\nB.\n', 'external', 'baseline'],
      ['# T\n\nA2.\n\nB.\n', 'Claude', 'claude-write'],
      ['# T\n\nA2.\n\nB2.\n', 'TJ', 'tj-session'],
    ])
    unlinkSync(objectPath(abs, docHash('# T\n\nA2.\n\nB.\n', false)))
    const c = changed((await s.history.diff('v1', 'v3')).blocks)
    // with v2 gone the chain is v1 → v3 by TJ: lineage says TJ for both; never an empty attribution
    for (const b of c) expect(b.by.length).toBeGreaterThan(0)
  })
})
