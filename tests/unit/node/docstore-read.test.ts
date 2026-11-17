// tests/unit/node/docstore-read.test.ts (P1). The M1 read-only DocStore (CONTRACTS §3.1, §3.5, §3.9, §4.6, §8.3, D46):
// snapshot and review over real files, the read-only review states (always answered, never thrown), in-flight WAL
// exclusion with needsRecovery vs a held lock, handoffs() across a restart, agent status/snapshot/thread/pending,
// DOC_GONE, cache revalidation, and write refusals.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { ulid } from 'ulid'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAnchor } from '../../../core/anchors'
import { docHash } from '../../../core/hash'
import { ptextOf } from '../../../core/ptext'
import { load } from '../../../core/splice/load'
import { decodeDoc, openDocStore, trailingInFlight } from '../../../node/docstore'
import { lockPathOf } from '../../../node/lock'
import { sharedMd } from '../../../node/md'
import { realId } from '../../../node/root'
import * as S from '../../../shared/schemas'
import type { DocStore, Hash, SidecarEvent, TextAnchor } from '../../../shared/types'
import { CONSTANTS } from '../../../shared/types'
import { fixtureText } from '../../fixtures/index'

const AT = '2026-10-15T17:00:00.000Z'
const DOC = 'basic.md'
const TEXT = fixtureText(DOC)

let root: string
const opened: DocStore[] = []

beforeAll(() => {
  root = realId(mkdtempSync(join(tmpdir(), 'mdr-store-')))
})
afterAll(async () => {
  for (const s of opened) await s.close()
  rmSync(root, { recursive: true, force: true })
})

/** A fresh subdirectory per test, with basic.md (or `text`) in it; returns its root-relative file path. */
let dirN = 0
function docIn(text: string | Buffer = TEXT, name = DOC): string {
  const dir = `d${++dirN}`
  mkdirSync(join(root, dir))
  writeFileSync(join(root, dir, name), text)
  return `${dir}/${name}`
}

async function open(file: string, o: { readOnly?: boolean; mode?: 'server' | 'direct' } = {}): Promise<DocStore> {
  const s = await openDocStore(root, file, { mode: o.mode ?? 'direct', lockTimeoutMs: CONSTANTS.LOCK_TIMEOUT_CLI_MS, ...(o.readOnly ? { readOnly: true } : {}) })
  opened.push(s)
  return s
}

const DOC_ID = `d_${ulid()}`
const header = (o: Record<string, unknown> = {}) => ({ type: 'header', schema: 'mdr.sidecar/2', docId: DOC_ID, file: DOC, createdAt: AT, createdBy: 'mdr/2.0.0-dev', ...o })

/** Sidecar lines with seqs/ids filled in. `rev` defaults to the latest doc.rev before the line. */
function lines(...evs: Array<Record<string, unknown>>): SidecarEvent[] {
  let rev = 0
  return evs.map((e, i) => {
    if (e.type === 'doc.rev') rev = e.rev as number
    return { seq: i + 1, id: `e_${ulid()}`, at: AT, rev, ...e } as unknown as SidecarEvent
  })
}
function writeSidecar(file: string, evs: readonly unknown[], hdr: unknown = header()): void {
  writeFileSync(join(root, file) + '.review.jsonl', [hdr, ...evs].map((l) => JSON.stringify(l)).join('\n') + '\n')
}
const baseline = (hash: Hash) => ({ type: 'doc.rev', by: 'system', rev: 1, prevRev: null, prevHash: null, hash, bytes: Buffer.byteLength(TEXT), cause: 'baseline' })

async function anchorOn(text: string, quote: string, rev = 1): Promise<TextAnchor> {
  const md = await sharedMd()
  const L = load(md, text)
  const p = ptextOf(L.doc, L)
  const from = p.text.indexOf(quote)
  return createAnchor(p, L.blocks, from, from + quote.length, rev)
}

const H0 = docHash(TEXT, false)
const T1 = `t_${ulid()}`
const T2 = `t_${ulid()}`
const S1 = `s_${ulid()}`
const PARA = 'The notes carry a member rate of 12% paid monthly. We launch in Q3.'

describe('§3.1 decoding', () => {
  it('decodeDoc: BOM stripped, fatal UTF-8 with the re-encode guard, MAX_DOC_BYTES', () => {
    expect(decodeDoc(Buffer.from('﻿# a\r\n', 'utf8'), 'x.md')).toEqual({ text: '# a\r\n', bom: true, readOnly: false })
    expect(decodeDoc(Buffer.from([0x23, 0x20, 0xff, 0x0a]), 'x.md').readOnly).toMatchObject({ code: 'NOT_UTF8' })
    // an overlong encoding is rejected by the fatal decoder; a lone surrogate never decodes to valid bytes either
    expect(decodeDoc(Buffer.from([0xc0, 0xaf]), 'x.md').readOnly).toMatchObject({ code: 'NOT_UTF8' })
    expect(decodeDoc(Buffer.alloc(CONSTANTS.MAX_DOC_BYTES + 1, 0x61), 'x.md').readOnly).toMatchObject({ code: 'TOO_LARGE' })
  })
})

describe('openDocStore (read-only, M1)', () => {
  it('a doc with no sidecar: rev 0, docId null, seq 0, the block map, raw-bytes hash; review is empty and writable-looking', async () => {
    const file = docIn()
    const s = await open(file, { readOnly: true })
    const snap = await s.snapshot()
    expect(S.DocSnapshotSchema.safeParse(snap).success).toBe(true)
    expect(snap).toMatchObject({ file, abs: join(root, file), docId: null, rev: 0, seq: 0, hash: H0, markdown: TEXT, bom: false, eol: '\n', readOnly: false })
    expect(snap.blocks.map((b) => b.ref)).toEqual(snap.blocks.map((_, i) => `b${i + 1}`))
    const r = await s.review()
    expect(S.ReviewStateSchema.omit({ presence: true, activity: true }).safeParse(r).success).toBe(true)
    expect(r).toMatchObject({ file, rev: 0, seq: 0, threads: [], suggestions: [], undeliveredHandoffs: [], readOnly: false })
    expect(await s.handoffs()).toEqual([])
  })

  it('BOM + CRLF: an expectHash computed with docHash(markdown, bom) equals the store hash (D40)', async () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# T\r\n\r\nBody.\r\n', 'utf8')])
    const s = await open(docIn(raw), { readOnly: true })
    const snap = await s.snapshot()
    expect(snap).toMatchObject({ bom: true, eol: '\r\n', markdown: '# T\r\n\r\nBody.\r\n', size: raw.length })
    expect(docHash(snap.markdown, snap.bom)).toBe(snap.hash)
  })

  it('refuses what the routes refuse: not .md, outside the root, missing', async () => {
    await expect(openDocStore(root, 'x.txt', { mode: 'direct', lockTimeoutMs: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(openDocStore(root, '../x.md', { mode: 'direct', lockTimeoutMs: 1 })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' })
    await expect(openDocStore(root, 'nope.md', { mode: 'direct', lockTimeoutMs: 1 })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('folds the sidecar: threads resolve against the ptext, pending suggestions are located, keys and policy come through', async () => {
    const file = docIn()
    const anchor = await anchorOn(TEXT, 'member rate')
    writeSidecar(file, lines(
      baseline(H0),
      { type: 'comment.add', by: 'TJ', key: 'tj:op_x', thread: T1, comment: `c_${ulid()}`, anchor, body: 'Is 12% current?' },
      {
        type: 'suggestion.add', by: 'Claude', thread: T2, newThread: true, suggestion: S1, comment: `c_${ulid()}`, body: 'tighten',
        anchor, range: { start: 1, end: 2, rev: 1 }, base: PARA, proposed: PARA.replace('Q3', 'Q4'), hunks: [{ del: 'Q3', ins: 'Q4', at: 0 }],
      },
      { type: 'policy.set', by: 'Claude', suggestOnly: true },
    ))
    const s = await open(file, { readOnly: true })
    const r = await s.review()
    expect(r).toMatchObject({ rev: 1, seq: 4, policy: { suggestOnly: true }, readOnly: false })
    expect(r.threads.find((t) => t.id === T1)!.resolution).toMatchObject({ state: 'exact' })
    expect(r.suggestions[0]).toMatchObject({ id: S1, status: 'pending', located: { start: 1, end: 2 } })
    expect((await s.snapshot()).docId).toBe(DOC_ID)
  })

  it('handoffs(): consumed by handoff.consumed and by an ack; round counts consumed lines; stable across a re-open (D46)', async () => {
    const file = docIn()
    writeSidecar(file, lines(
      baseline(H0),
      { type: 'handoff.sent', by: 'TJ', message: 'one', delivery: 'waiter' },
      { type: 'handoff.consumed', by: 'Claude', handoffs: [2], via: 'waiter', waiter: 'w_0123456789abcdef' },
      { type: 'handoff.sent', by: 'TJ', message: null, delivery: 'latched' },
      { type: 'handoff.sent', by: 'TJ', message: 'three', delivery: 'clipboard' },
      { type: 'ack', by: 'Claude', upTo: 4 },
    ))
    const s1 = await open(file, { readOnly: true })
    const all = await s1.handoffs()
    expect(all.map((h) => [h.seq, h.round, h.consumed])).toEqual([[2, 1, true], [4, 2, true], [5, 3, false]])
    expect((await s1.handoffs({ unconsumed: true })).map((h) => h.seq)).toEqual([5])
    const s2 = await open(file, { mode: 'server' })
    expect(await s2.handoffs()).toEqual(all)
    expect((await s2.review()).undeliveredHandoffs).toEqual([5])
  })
})

describe('§8.3 read-only review states: answered, never thrown', () => {
  it('SIDECAR_CORRUPT: the valid prefix folds, a warning names the line, writes and pending refuse', async () => {
    const file = docIn()
    const good = lines(baseline(H0), { type: 'comment.add', by: 'TJ', thread: T1, comment: `c_${ulid()}`, anchor: { kind: 'doc' }, body: 'kept' })
    writeFileSync(join(root, file) + '.review.jsonl', [header(), ...good].map((l) => JSON.stringify(l)).join('\n') + '\n{oops\n' + JSON.stringify({ ...good[1], seq: 4 }) + '\n')
    const s = await open(file, { mode: 'server' })
    const r = await s.review()
    expect(r.readOnly).toMatchObject({ code: 'SIDECAR_CORRUPT' })
    expect(r.threads.map((t) => t.id)).toEqual([T1])
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: 'SIDECAR_INVALID_EVENT', line: 4 }))
    expect((await s.snapshot()).readOnly).toMatchObject({ code: 'SIDECAR_CORRUPT' })
    await expect(s.agent.pending()).rejects.toMatchObject({ code: 'SIDECAR_CORRUPT' })
    await expect(s.tj.createThread({ opKey: `op_${ulid()}`, anchor: { kind: 'doc' }, anchorRev: 0, body: 'x' })).rejects.toMatchObject({ code: 'SIDECAR_CORRUPT' })
    expect((await s.agent.status()).readOnly).toMatchObject({ code: 'SIDECAR_CORRUPT' })
  })

  it('SIDECAR_SCHEMA_UNSUPPORTED: no threads, no suggestions; pending refuses', async () => {
    const file = docIn()
    writeSidecar(file, lines(baseline(H0), { type: 'comment.add', by: 'TJ', thread: T1, comment: `c_${ulid()}`, anchor: { kind: 'doc' }, body: 'x' }), header({ schema: 'mdr.sidecar/9' }))
    const s = await open(file, { readOnly: true })
    const r = await s.review()
    expect(r).toMatchObject({ readOnly: { code: 'SIDECAR_SCHEMA_UNSUPPORTED' }, threads: [], suggestions: [], rev: 0, seq: 0 })
    await expect(s.agent.pending()).rejects.toMatchObject({ code: 'SIDECAR_SCHEMA_UNSUPPORTED' })
  })

  it('NOT_UTF8 and TOO_LARGE: the full fold, every text anchor detached, doc anchors still doc', async () => {
    const anchor = await anchorOn(TEXT, 'member rate')
    const evs = (h: Hash) => lines(baseline(h),
      { type: 'comment.add', by: 'TJ', thread: T1, comment: `c_${ulid()}`, anchor, body: 'text' },
      { type: 'comment.add', by: 'TJ', thread: T2, comment: `c_${ulid()}`, anchor: { kind: 'doc' }, body: 'doc' })
    for (const [code, raw] of [
      ['NOT_UTF8', Buffer.concat([Buffer.from(TEXT, 'utf8'), Buffer.from([0xff])])],
      ['TOO_LARGE', Buffer.alloc(CONSTANTS.MAX_DOC_BYTES + 10, 0x61)],
    ] as const) {
      const file = docIn(raw)
      writeSidecar(file, evs(H0))
      const s = await open(file, { readOnly: true })
      const r = await s.review()
      expect(r.readOnly, code).toMatchObject({ code })
      expect(r.threads.map((t) => t.resolution.state), code).toEqual(['detached', 'doc'])
      const snap = await s.snapshot()
      expect(snap).toMatchObject({ readOnly: { code }, markdown: '', blocks: [], size: raw.length })
    }
  })
})

describe('§4.6 in-flight WAL batches (unlocked readers)', () => {
  const H1 = 'f'.repeat(64)
  function crashedBatch(file: string): void {
    writeSidecar(file, lines(
      baseline(H0),
      { type: 'doc.rev', by: 'Claude', rev: 2, prevRev: 1, prevHash: H0, hash: H1, bytes: 9, cause: 'cli', key: 'cli:k', wal: { rev: 2, hash: H1 } },
      { type: 'comment.add', by: 'Claude', key: 'cli:k', thread: T1, comment: `c_${ulid()}`, anchor: { kind: 'doc' }, body: 'not landed', wal: { rev: 2, hash: H1 } },
    ))
  }

  it('trailingInFlight finds the last batch only when its hash is not the disk hash', () => {
    const evs = lines(baseline(H0), { type: 'doc.rev', by: 'TJ', rev: 2, prevRev: 1, prevHash: H0, hash: H1, bytes: 1, cause: 'save', wal: { rev: 2, hash: H1 } })
    expect(trailingInFlight(evs, H0)).toEqual({ rev: 2, from: 1 })
    expect(trailingInFlight(evs, H1)).toBeNull()
    expect(trailingInFlight(evs.slice(0, 1), H0)).toBeNull()
  })

  it('excluded from the fold; the lock free → needsRecovery with a NEEDS_RECOVERY warning', async () => {
    const file = docIn()
    crashedBatch(file)
    const s = await open(file, { readOnly: true })
    const r = await s.review()
    expect(r).toMatchObject({ rev: 1, seq: 1, threads: [] })
    expect(r.warnings.map((w) => w.code)).toContain('NEEDS_RECOVERY')
    const st = await s.agent.status()
    expect(st).toMatchObject({ needsRecovery: true, rev: 1, seq: 1 })
  })

  it('with the doc lock held it is a write in progress: still excluded, but no needsRecovery', async () => {
    const file = docIn()
    crashedBatch(file)
    const abs = join(root, file)
    mkdirSync(join(root, file, '..', '.review', 'locks'), { recursive: true })
    const release = await lockfile.lock(abs, { lockfilePath: lockPathOf(abs), realpath: false, stale: CONSTANTS.LOCK_STALE_MS })
    try {
      const s = await open(file, { readOnly: true })
      const st = await s.agent.status()
      expect(st).toMatchObject({ needsRecovery: false, rev: 1, seq: 1 })
    } finally {
      await release()
    }
  })

  it('a landed batch (wal.hash = disk) is folded', async () => {
    const file = docIn('# New\n')
    const h = docHash('# New\n', false)
    writeSidecar(file, lines(
      baseline(H0),
      { type: 'doc.rev', by: 'Claude', rev: 2, prevRev: 1, prevHash: H0, hash: h, bytes: 6, cause: 'cli', wal: { rev: 2, hash: h } },
    ))
    const st = await (await open(file, { readOnly: true })).agent.status()
    expect(st).toMatchObject({ rev: 2, needsRecovery: false })
  })

  it('an open TJ session in the log reads as needsRecovery (no live writer owns it; the next writer recovers it)', async () => {
    const edited = TEXT + '\nTJ typed this.\n'
    const file = docIn(edited)
    writeSidecar(file, lines(
      baseline(H0),
      { type: 'doc.rev', by: 'TJ', rev: 2, prevRev: 1, prevHash: H0, hash: docHash(edited, false), bytes: Buffer.byteLength(edited), cause: 'save', clientId: `k_${ulid()}`, saveId: 1 },
    ))
    const st = await (await open(file, { readOnly: true })).agent.status()
    expect(st.needsRecovery).toBe(true)
    // §7.1: status never flushes, and its pendingCount counts the open session as one edit
    expect(st.pendingCount).toBe(1)
  })
})

describe('caches revalidate by stat', () => {
  it('an external sidecar append and an external doc edit are seen on the next read', async () => {
    const file = docIn()
    writeSidecar(file, lines(baseline(H0)))
    const s = await open(file, { mode: 'server' })
    expect((await s.review()).seq).toBe(1)
    appendFileSync(join(root, file) + '.review.jsonl', JSON.stringify({ seq: 2, id: `e_${ulid()}`, at: AT, rev: 1, type: 'read-marker', by: 'TJ', thread: null, upTo: 1 }) + '\n')
    expect((await s.review()).seq).toBe(2)
    writeFileSync(join(root, file), TEXT + '\nAdded.\n')
    const snap = await s.snapshot()
    expect(snap.markdown).toContain('Added.')
    expect(snap.hash).toBe(docHash(TEXT + '\nAdded.\n', false))
  })

  it('a deleted file with a sidecar → DOC_GONE on reads; the open still succeeds', async () => {
    const file = docIn()
    writeSidecar(file, lines(baseline(H0)))
    const s = await open(file, { readOnly: true })
    unlinkSync(join(root, file))
    await expect(s.snapshot()).rejects.toMatchObject({ code: 'DOC_GONE', status: 410 })
    await expect(s.review()).rejects.toMatchObject({ code: 'DOC_GONE' })
    const again = await open(file, { readOnly: true })
    await expect(again.agent.status()).rejects.toMatchObject({ code: 'DOC_GONE' })
  })
})

describe('agent reads', () => {
  let s: DocStore
  let file: string
  beforeEach(async () => {
    file = docIn()
    const anchor = await anchorOn(TEXT, 'member rate')
    writeSidecar(file, lines(
      baseline(H0),
      { type: 'comment.add', by: 'TJ', thread: T1, comment: `c_${ulid()}`, anchor, body: 'root' },
      { type: 'comment.reply', by: 'Claude', thread: T1, comment: `c_${ulid()}`, body: 'reply' },
      {
        type: 'suggestion.add', by: 'Claude', thread: T1, newThread: false, suggestion: S1,
        anchor, range: { start: 1, end: 2, rev: 1 }, base: PARA, proposed: PARA.replace('Q3', 'Q4'), hunks: [{ del: 'Q3', ins: 'Q4', at: 0 }],
      },
      { type: 'handoff.sent', by: 'TJ', message: 'look', delivery: 'waiter' },
    ))
    s = await open(file, { mode: 'server' })
  })

  it('status: counts, cursor, handoff, via; schema-valid with the route fields added', async () => {
    const st = await s.agent.status()
    expect(st).toMatchObject({
      via: 'server', file, rev: 1, seq: 5, threads: { open: 1, resolved: 0, detached: 0 }, suggestions: { pending: 1, stale: 0 },
      cursor: { ack: 0, latest: 5 }, handoff: { undelivered: [5] }, legacySidecar: false, needsRecovery: false, readOnly: false,
    })
    // non-Claude, non-bookkeeping lines after the ack: comment.add and handoff.sent
    expect(st.pendingCount).toBe(2)
    const wire = { ...st, server: { state: 'up', port: 1, url: 'http://127.0.0.1:1/' }, presence: { waiter: 'none' }, activity: null }
    expect(S.StatusResultSchema.safeParse(wire).error?.issues ?? []).toEqual([])
  })

  it('direct mode has no handoff module: status and review carry no presence/activity; the CLI\'s placeholders complete them (§3.9)', async () => {
    const d = await open(file, { mode: 'direct' })
    const st = await d.agent.status()
    expect(st.via).toBe('direct')
    for (const k of ['presence', 'activity', 'server']) expect(st).not.toHaveProperty(k)
    const rv = await d.review()
    for (const k of ['presence', 'activity']) expect(rv).not.toHaveProperty(k)
    // what CLI direct mode adds (§3.9: presence { waiter: 'none' }, activity null) makes a valid StatusResult
    const wire = { ...st, server: { state: 'down', port: null, url: null }, presence: { waiter: 'none' }, activity: null }
    expect(S.StatusResultSchema.safeParse(wire).error?.issues ?? []).toEqual([])
    // and the store's counts are the same whichever mode reads them
    const { via: _v1, ...a } = st
    const { via: _v2, ...b } = await s.agent.status()
    expect(a).toEqual(b)
  })

  it('status reports an mdr 1 sidecar (never read)', async () => {
    writeFileSync(join(root, file) + '.comments.jsonl', '{}\n')
    const st = await s.agent.status()
    expect(st.legacySidecar).toBe(true)
    expect(st.warnings.map((w) => w.code)).toContain('LEGACY_SIDECAR')
  })

  it('snapshot: md / text per block, from..to slicing, refs past the end → BLOCK_NOT_FOUND', async () => {
    const all = await s.agent.snapshot({ md: true, text: true })
    expect(S.AgentSnapshotSchema.safeParse(all).success).toBe(true)
    expect(all.blocks[1]).toMatchObject({ ref: 'b2', type: 'paragraph', md: PARA, text: PARA })
    expect(all.threads[0]).toMatchObject({ id: T1, anchor: { state: 'ok', block: 'b2', quote: 'member rate' }, by: 'TJ', replies: 1 })
    expect(all.suggestions[0]).toMatchObject({ id: S1, block: 'b2', line: 3, hunks: [{ del: 'Q3', ins: 'Q4' }] })
    const part = await s.agent.snapshot({ from: 'b2', to: 'b3' })
    expect(part.blocks.map((b) => b.ref)).toEqual(['b2', 'b3'])
    expect(part.blocks[0]!.md).toBeUndefined()
    await expect(s.agent.snapshot({ from: 'b99' })).rejects.toMatchObject({ code: 'BLOCK_NOT_FOUND' })
  })

  it('thread: anchor view with the block markdown as context, messages, suggestions; unknown → THREAD_NOT_FOUND', async () => {
    const t = await s.agent.thread(T1 as `t_${string}`)
    expect(S.ThreadDetailSchema.safeParse(t).success).toBe(true)
    expect(t.thread.anchor).toMatchObject({ state: 'ok', block: 'b2', line: 3, context: PARA })
    expect(t.thread.messages.map((m) => m.body)).toEqual(['root', 'reply'])
    expect(t.thread.suggestions[0]).toMatchObject({ id: S1, status: 'pending', block: 'b2', base: PARA })
    await expect(s.agent.thread(`t_${ulid()}`)).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND', status: 404 })
  })

  it('pending: through buildPending with since/cursor from the fold (the digest itself is P4\'s)', async () => {
    const p = await s.agent.pending()
    expect(S.PendingResultSchema.safeParse(p).success).toBe(true)
    expect(p).toMatchObject({ via: 'server', file, rev: 1, since: 0, cursor: 5 })
  })

  it('writes refuse READ_ONLY on a readOnly store; a writable store commits (an empty batch is a noop)', async () => {
    const ro = await open(file, { readOnly: true })
    await expect(ro.agent.batch({ ops: [] })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(ro.appendEvents([])).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(s.agent.batch({ ops: [] })).resolves.toMatchObject({ ok: true, noop: true, results: [] })
    await expect(ro.flushTjSession('beacon')).resolves.toBeUndefined()
  })
})
