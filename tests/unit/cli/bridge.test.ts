// tests/unit/cli/bridge.test.ts. The CLI contract of import-gdoc, export-gdoc and export-docx (cli/commands/bridge.ts),
// run in-process over a tmp root: direct mode, and import through a running server.
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { openDocStore } from '../../../node/docstore'
import { tmpRoot, type TmpRoot } from '../../helpers/tmpRoot'
import { cli, realServer, type RealServer } from './runner'

let root: TmpRoot | null = null
let server: RealServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
  root?.cleanup()
  root = null
})

const FX = new URL('../../fixtures/gdocs/', import.meta.url)
const fx = (name: string): string => readFileSync(new URL(name, FX), 'utf8')
const ENV = { MDR_USER_NAME: 'Ana Díaz', MDR_PROTECTED_SEGMENTS: '' }

describe('import-gdoc', () => {
  it('writes the .md and posts every open comment, reply and suggestion (direct mode)', async () => {
    root = tmpRoot({ name: 'bridge-import', fixtures: 'none' })
    const json = root.path('read.json')
    const r = await cli(['import-gdoc', root.path('feedback.md'), '--gdoc-json', json], { env: ENV, files: { [json]: fx('spike-small.read_doc.json') } })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.json).toMatchObject({
      ok: true, file: 'feedback.md', title: 'mdr-spike-scratch (delete me)', documentId: 'spike-small',
      counts: { threads: 5, anchored: 4, docLevel: 1, replies: 1, suggestions: 1, suggestionsAsComments: 0, skippedResolved: 1 },
    })
    expect(root.read('feedback.md')).toContain('# Spike heading one')
    // the second "pricing claim" got the comment
    const c2 = r.json.items.find((i: { source: string }) => i.source === 'doco.C2')
    const t = await cli(['thread', root.path('feedback.md'), c2.thread], { env: ENV })
    expect(t.json.thread.anchor).toMatchObject({ state: 'ok', quote: 'pricing claim' })
    expect(t.json.thread.messages[0].body).toBe('Pat Author: C2 on SECOND pricing claim')
    const store = await openDocStore(root.root, 'feedback.md', { mode: 'direct', readOnly: true, lockTimeoutMs: 1000 })
    try {
      const th = (await store.review()).threads.find((x) => x.id === c2.thread)!
      // ptext offsets of the paragraph's SECOND "pricing claim" (the first is at 247), as the parser computed them
      expect(th.resolution).toMatchObject({ state: 'exact', from: 268, to: 281 })
    } finally {
      await store.close()
    }
  })

  it('never overwrites: an existing .md or sidecar is refused before anything is written', async () => {
    root = tmpRoot({ name: 'bridge-import-exists', fixtures: 'none', files: { 'taken.md': '# mine\n', 'orphan.md.review.jsonl': '' } })
    const json = root.path('read.json')
    const files = { [json]: fx('spike-small.read_doc.json') }
    const a = await cli(['import-gdoc', root.path('taken.md'), '--gdoc-json', json], { env: ENV, files })
    expect(a.code).not.toBe(0)
    expect(a.json.error).toMatchObject({ code: 'BAD_REQUEST' })
    expect(root.read('taken.md')).toBe('# mine\n')
    const b = await cli(['import-gdoc', root.path('orphan.md'), '--gdoc-json', json], { env: ENV, files })
    expect(b.json.error.message).toMatch(/never overwrites a review/)
    expect(root.exists('orphan.md')).toBe(false)
  })

  it('USAGE without --gdoc-json; BAD_REQUEST for JSON that is not a read_doc result', async () => {
    root = tmpRoot({ name: 'bridge-import-bad', fixtures: 'none' })
    const u = await cli(['import-gdoc', root.path('x.md')], { env: ENV })
    expect(u.json.error.code).toBe('USAGE')
    const json = root.path('read.json')
    const bad = await cli(['import-gdoc', root.path('x.md'), '--gdoc-json', json], { env: ENV, files: { [json]: '{"hello":1}' } })
    expect(bad.json.error).toMatchObject({ code: 'BAD_REQUEST' })
    expect(bad.json.error.message).toMatch(/not a Google Docs read_doc result/)
    const notJson = await cli(['import-gdoc', root.path('x.md'), '--gdoc-json', json], { env: ENV, files: { [json]: 'nope' } })
    expect(notJson.json.error.message).toMatch(/is not JSON/)
    expect(root.exists('x.md')).toBe(false)
  })

  it('goes through the running server when one is up', async () => {
    root = tmpRoot({ name: 'bridge-import-up', fixtures: 'none', files: { 'other.md': '# x\n' } })
    server = await realServer(root.root)
    const json = root.path('read.json')
    const r = await cli(['import-gdoc', root.path('live.md'), '--gdoc-json', json, '--include-resolved'], { env: ENV, files: { [json]: fx('export-brief-commented.read_doc.json') } })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.json.counts).toMatchObject({ threads: 8, anchored: 8, replies: 2 })
    const p = await cli(['status', root.path('live.md')], { env: ENV })
    expect(p.json.server).toMatchObject({ state: 'up' })
  })
})

describe('export-gdoc', () => {
  it('step 1 writes the upload copy and its file reference; step 2 the insertComment requests; step 3 the replies', async () => {
    root = tmpRoot({ name: 'bridge-export', fixtures: 'none', files: { 'brief.md': `---\nowner: x\n---\n\n${fx('export-brief.upload.md')}` } })
    const f = root.path('brief.md')
    const add = async (args: string[]): Promise<string> => {
      const r = await cli([...args], { env: ENV })
      expect(r.code, r.stdout).toBe(0)
      return r.json.results[0].thread as string
    }
    await add(['comment', f, '--quote', 'garden classes', '--body', 'Define this.'])
    const t = await add(['comment', f, '--quote', '12% member price', '--occurrence', '2', '--body', 'Second one.'])
    await cli(['reply', f, t, '--body', 'Agreed.'], { env: ENV })
    await add(['comment', f, '--doc', '--body', 'Ship by Dec 1.'])

    const s1 = await cli(['export-gdoc', f], { env: ENV })
    expect(s1.json).toMatchObject({ ok: true, step: 'upload', title: 'Q4 Launch Brief', openThreads: 3 })
    expect(s1.json.fileRef).toBe(`sha256:${s1.json.sha256}:${s1.json.uploadPath}`)
    expect(s1.json.uploadPath).toMatch(/\.review\/exports\/brief\.gdoc-upload\.txt$/)
    const upload = readFileSync(s1.json.uploadPath, 'utf8')
    expect(upload.startsWith('# Q4 Launch Brief')).toBe(true)                // frontmatter stripped

    const json = root.path('readback.json')
    const s2 = await cli(['export-gdoc', f, '--gdoc-json', json], { env: ENV, files: { [json]: fx('export-brief.read_doc.json') } })
    expect(s2.json).toMatchObject({ ok: true, step: 'comments', replies: 1 })
    expect(s2.json.requests).toEqual([
      { insertComment: { content: 'Claude: Define this.', range: { startIndex: 32, endIndex: 46 } } },
      { insertComment: { content: 'Claude: Second one.', range: { startIndex: 284, endIndex: 300 } } },
      { insertComment: { content: '(General comment) Claude: Ship by Dec 1.', range: { startIndex: 1, endIndex: 16 } } },
    ])
    expect(existsSync(s2.json.planPath)).toBe(true)

    const s3 = await cli(['export-gdoc', f, '--comment-ids', 'c1, c2,c3'], { env: ENV })
    expect(s3.json).toEqual({ ok: true, step: 'replies', file: 'brief.md', requests: [{ addCommentReply: { commentId: 'c2', post: { content: 'Claude: Agreed.' } } }] })
    const wrong = await cli(['export-gdoc', f, '--comment-ids', 'c1'], { env: ENV })
    expect(wrong.json.error).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses to plan comments on a Google Doc that already has comments', async () => {
    root = tmpRoot({ name: 'bridge-export-busy', fixtures: 'none', files: { 'brief.md': fx('export-brief.upload.md') } })
    const json = root.path('readback.json')
    const r = await cli(['export-gdoc', root.path('brief.md'), '--gdoc-json', json], { env: ENV, files: { [json]: fx('export-brief-commented.read_doc.json') } })
    expect(r.json.error).toMatchObject({ code: 'BAD_REQUEST' })
    expect(r.json.error.message).toMatch(/already has 8 comment/)
  })

  it('--comment-ids before any plan is USAGE', async () => {
    root = tmpRoot({ name: 'bridge-export-noplan', fixtures: 'none', files: { 'a.md': '# a\n' } })
    const r = await cli(['export-gdoc', root.path('a.md'), '--comment-ids', 'x'], { env: ENV })
    expect(r.json.error.code).toBe('USAGE')
  })
})

describe('export-docx', () => {
  it('writes beside the .md, refuses to overwrite without --force, honours --out', async () => {
    root = tmpRoot({ name: 'bridge-docx', fixtures: 'none', files: { 'memo.md': '# Memo\n\nThe pricing claim is here.\n' } })
    const f = root.path('memo.md')
    await cli(['comment', f, '--quote', 'pricing claim', '--body', 'Source?'], { env: ENV })
    const a = await cli(['export-docx', f], { env: ENV })
    expect(a.json).toMatchObject({ ok: true, file: 'memo.md', comments: 1, replies: 0, general: 0 })
    expect(a.json.out).toBe(root.path('memo.docx'))
    expect(readFileSync(a.json.out).subarray(0, 2).toString()).toBe('PK')
    const again = await cli(['export-docx', f], { env: ENV })
    expect(again.json.error.code).toBe('BAD_REQUEST')
    expect((await cli(['export-docx', f, '--overwrite'], { env: ENV })).code).toBe(0)
    const other = await cli(['export-docx', f, '--out', root.path('out/x.docx')], { env: ENV })
    expect(other.json.out).toBe(root.path('out/x.docx'))
    expect((await cli(['export-docx', f, '--out', root.path('x.pdf')], { env: ENV })).json.error.code).toBe('BAD_REQUEST')
  })
})
