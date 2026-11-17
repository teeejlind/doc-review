// cli/commands/bridge.ts. The Google Docs and Word bridges (spike/gdocs/FINDINGS.md):
//   mdr import-gdoc <new.md> --gdoc-json F [--include-resolved]
//       Converts a saved Google Docs read_doc result into <new.md> and posts every open comment (with its replies) and
//       every suggested edit as review items. Refuses to overwrite: <new.md> and its sidecar must not exist yet.
//   mdr export-gdoc <file.md>                        → step 1: write the upload copy, print its file reference
//   mdr export-gdoc <file.md> --gdoc-json F          → step 2: print the insertComment requests for the new doc
//   mdr export-gdoc <file.md> --gdoc-json F --comment-ids a,b,…  → step 3: print the addCommentReply requests
//   mdr export-docx <file.md> [--out F]              → a Word file with every open thread as an anchored comment
// The Google connector is a Claude tool, so mdr never talks to Google: it reads what Claude saved and prints the
// exact requests Claude sends. Nothing here posts anywhere.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AgentOp, BatchRequest, BatchResult, StoreReviewState, ThreadId } from '../../shared/types'
import { parseGdoc, type GdocImport } from '../../core/bridge/gdoc-read'
import { planImport, type ImportStep } from '../../core/bridge/import-plan'
import { exportThreads, planGdocComments, planGdocReplies, type GdocCommentPlan, type PlacedComment } from '../../core/bridge/export-plan'
import { buildDocx } from '../../core/bridge/docx'
import { ptextOf } from '../../core/ptext'
import { load } from '../../core/splice/load'
import { sharedMd } from '../../node/md'
import { withStore } from '../direct'
import { locateFile, type Located } from '../discover'
import { agentCall, q } from '../http'
import { cliErr, CliExit, fromError } from '../output'
import { arg, flag, localUser, opt, serverFor, type Ctx } from './common'

type Apply = (req: BatchRequest) => Promise<BatchResult>

/** Run `fn` with a batch function: the same-root server when it is up, else one direct store for the whole run. */
export async function withApply<T>(ctx: Ctx, at: Located, fn: (apply: Apply) => Promise<T>): Promise<T> {
  const up = await serverFor(ctx, at.root)
  if (up) return fn((req) => agentCall<BatchResult>(up.conn, 'POST', `/api/agent/batch${q({ file: at.rel })}`, req))
  return withStore(ctx.io, at, {}, (s) => fn((req) => s.agent.batch(req)))
}

/** The error code of a refused batch, or null when it went through. */
async function attempt(apply: Apply, ops: AgentOp[]): Promise<{ res: BatchResult } | { code: string; message: string }> {
  try {
    return { res: await apply({ ops }) }
  } catch (e) {
    const doc = fromError(e).doc as { error?: { code?: string; message?: string } }
    const code = doc.error?.code ?? 'INTERNAL'
    // infrastructure failures stop the import; content refusals fall back
    if (code === 'LOCK_TIMEOUT' || code === 'SERVER_UNREACHABLE' || code === 'INTERNAL' || code === 'READ_ONLY' || code === 'SIDECAR_CORRUPT') throw e
    return { code, message: doc.error?.message ?? code }
  }
}

function readJsonFile(ctx: Ctx, path: string, flagName: string): unknown {
  let text: string
  try {
    text = ctx.io.readFile(resolve(ctx.io.cwd, path))
  } catch (e) {
    throw cliErr('USAGE', `cannot read ${flagName} ${path}: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw cliErr('BAD_REQUEST', `${flagName} ${path} is not JSON (save the read_doc result exactly as the tool returned it)`)
  }
}

function parseOrFail(raw: unknown): GdocImport {
  try {
    return parseGdoc(raw)
  } catch (e) {
    throw cliErr('BAD_REQUEST', (e as Error).message, { hint: 'pass the saved result of the Google Docs read_doc tool, called with commentsIncluded: true' })
  }
}

export interface ImportItem {
  source: string
  kind: 'thread' | 'suggestion'
  author: string
  /** Where it landed. */
  landed: 'text' | 'doc'
  thread?: ThreadId
  suggestion?: string
  replies?: number
  resolved?: true
  /** Why it is doc-level, when it is. */
  why?: string
}

export interface ImportGdocResult {
  ok: true
  file: string
  title: string
  documentId?: string
  counts: { threads: number; anchored: number; docLevel: number; replies: number; suggestions: number; suggestionsAsComments: number; skippedResolved: number }
  notes: string[]
  items: ImportItem[]
}

async function runStep(apply: Apply, st: ImportStep): Promise<ImportItem> {
  const item: ImportItem = { source: st.sourceId, kind: st.kind, author: st.author, landed: 'text' }
  let res: BatchResult | null = null
  if (st.op === st.fallback) {
    item.landed = 'doc'
    if (st.docWhy) item.why = st.docWhy
  } else {
    const r = await attempt(apply, [st.op])
    if ('res' in r) res = r.res
    else {
      item.landed = 'doc'
      item.why = `${r.code}: ${r.message}`
    }
  }
  if (!res) {
    const r = await attempt(apply, [st.fallback])
    if (!('res' in r)) throw cliErr('INTERNAL', `could not post ${st.kind} ${st.sourceId} even as a doc comment: ${r.code}: ${r.message}`)
    res = r.res
  }
  const first = res.results[0]
  if (first?.thread) item.thread = first.thread
  if (first?.suggestion) item.suggestion = first.suggestion
  if (item.thread && (st.replies.length || st.resolve)) {
    const ops: AgentOp[] = st.replies.map((body, i) => ({ op: 'reply', thread: item.thread!, body, key: `${keyOf(st.op)}:r${i + 1}` }))
    if (st.resolve) ops.push({ op: 'resolve', thread: item.thread, key: `${keyOf(st.op)}:resolve` })
    const r = await attempt(apply, ops)
    if (!('res' in r)) throw cliErr('INTERNAL', `could not post the replies of ${st.sourceId}: ${r.code}: ${r.message}`)
    if (st.replies.length) item.replies = st.replies.length
    if (st.resolve) item.resolved = true
  }
  return item
}
const keyOf = (op: AgentOp): string => op.key ?? 'gdoc'

export async function runImportGdoc(ctx: Ctx): Promise<CliExit> {
  const target = resolve(ctx.io.cwd, arg(ctx, 0, 'new.md'))
  const jsonPath = opt(ctx, 'gdocJson')
  if (jsonPath === undefined) throw cliErr('USAGE', 'import-gdoc needs --gdoc-json F (the saved read_doc result, commentsIncluded: true)')
  if (!/\.(md|markdown)$/i.test(target)) throw cliErr('BAD_REQUEST', `${basename(target)}: the new file must end in .md`)
  if (existsSync(target)) throw cliErr('BAD_REQUEST', `${target} already exists; import-gdoc never overwrites`, { hint: 'pick a new file name' })
  if (existsSync(target + '.review.jsonl')) throw cliErr('BAD_REQUEST', `${target}.review.jsonl already exists; import-gdoc never overwrites a review`, { hint: 'pick a new file name' })
  if (!existsSync(dirname(target))) throw cliErr('FILE_NOT_FOUND', `${dirname(target)} does not exist`)
  const imp = parseOrFail(readJsonFile(ctx, jsonPath, '--gdoc-json'))
  const plan = planImport(imp, { includeResolved: flag(ctx, 'includeResolved') })

  writeFileSync(target, imp.markdown, { flag: 'wx' })
  const at = locateFile(target, ctx.io.cwd, opt(ctx, 'root'))
  const items: ImportItem[] = []
  await withApply(ctx, at, async (apply) => {
    for (const st of plan.steps) items.push(await runStep(apply, st))
  })
  const threads = items.filter((i) => i.kind === 'thread')
  const sugg = items.filter((i) => i.kind === 'suggestion')
  const doc: ImportGdocResult = {
    ok: true,
    file: at.rel,
    title: imp.title,
    ...(imp.documentId ? { documentId: imp.documentId } : {}),
    counts: {
      threads: threads.length,
      anchored: threads.filter((i) => i.landed === 'text').length,
      docLevel: threads.filter((i) => i.landed === 'doc').length,
      replies: threads.reduce((n, i) => n + (i.replies ?? 0), 0),
      suggestions: sugg.filter((i) => i.landed === 'text').length,
      suggestionsAsComments: sugg.filter((i) => i.landed === 'doc').length,
      skippedResolved: plan.skipped.resolvedThreads,
    },
    notes: imp.notes,
    items,
  }
  return new CliExit(doc, 0)
}

// ---------------------------------------------------------------------------------------------------------------
// export helpers shared by export-gdoc and export-docx

/** Current markdown plus the folded review state, read-only (safe while a server runs). */
export async function readReview(ctx: Ctx, at: Located): Promise<{ markdown: string; state: StoreReviewState }> {
  return withStore(ctx.io, at, { readOnly: true }, async (s) => ({ markdown: (await s.snapshot()).markdown, state: await s.review() }))
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function writeOut(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

/** Working files of the Google export live under the root's .review/ (never .md, so the server never lists them). */
export const exportDirOf = (root: string): string => join(root, '.review', 'exports')

// ---------------------------------------------------------------------------------------------------------------
// export-gdoc

/** The doc's ptext (what thread.resolution offsets index into). */
export async function ptextOfMarkdown(markdown: string): Promise<string> {
  const md = await sharedMd()
  const L = load(md, markdown)
  return ptextOf(L.doc, L).text
}

/** YAML frontmatter is review metadata, not content: Google would render it as text. */
export const stripFrontmatter = (md: string): string => md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n(?:\r?\n)*/, '')

export interface ExportGdocPrepared {
  ok: true
  step: 'upload'
  file: string
  title: string
  uploadPath: string
  sha256: string
  /** Pass as create_file's base64Content, with contentMimeType text/markdown. */
  fileRef: string
  openThreads: number
}
export interface ExportGdocComments {
  ok: true
  step: 'comments'
  file: string
  documentId?: string
  requests: GdocCommentPlan['requests']
  placed: Array<Omit<PlacedComment, 'replies'> & { replies: number }>
  replies: number
  planPath: string
}
export interface ExportGdocReplies {
  ok: true
  step: 'replies'
  file: string
  requests: ReturnType<typeof planGdocReplies>
}

const titleOf = (markdown: string, abs: string): string => {
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(stripFrontmatter(markdown))
  return (h?.[1] ?? basename(abs).replace(/\.(md|markdown)$/i, '')).replace(/[*_`\\]/g, '').slice(0, 200)
}

export async function runExportGdoc(ctx: Ctx): Promise<CliExit> {
  const at = locateFile(arg(ctx, 0, 'file'), ctx.io.cwd, opt(ctx, 'root'))
  const dir = exportDirOf(at.root)
  const stem = at.rel.replace(/[\\/]/g, '__').replace(/\.(md|markdown)$/i, '')
  const planPath = join(dir, `${stem}.gdoc-plan.json`)
  const idsArg = opt(ctx, 'commentIds')
  const jsonPath = opt(ctx, 'gdocJson')

  if (idsArg !== undefined) {
    let saved: { file: string; placed: PlacedComment[] }
    try {
      saved = JSON.parse(readFileSync(planPath, 'utf8')) as { file: string; placed: PlacedComment[] }
    } catch {
      throw cliErr('USAGE', `no saved comment plan for ${at.rel}; run export-gdoc ${at.rel} --gdoc-json F first`)
    }
    const ids = idsArg.split(',').map((s) => s.trim()).filter(Boolean)
    let requests: ReturnType<typeof planGdocReplies>
    try {
      requests = planGdocReplies(saved.placed, ids)
    } catch (e) {
      throw cliErr('BAD_REQUEST', (e as Error).message)
    }
    const doc: ExportGdocReplies = { ok: true, step: 'replies', file: at.rel, requests }
    return new CliExit(doc, 0)
  }

  const { markdown, state } = await readReview(ctx, at)
  const ptext = await ptextOfMarkdown(markdown)
  const threads = exportThreads(state.threads, state.suggestions, ptext, localUser(ctx).displayName)

  if (jsonPath === undefined) {
    const uploadPath = join(dir, `${stem}.gdoc-upload.txt`)
    writeOut(uploadPath, stripFrontmatter(markdown))
    const sha = sha256File(uploadPath)
    const doc: ExportGdocPrepared = {
      ok: true, step: 'upload', file: at.rel, title: titleOf(markdown, at.abs), uploadPath, sha256: sha,
      fileRef: `sha256:${sha}:${uploadPath.replace(/\\/g, '/')}`, openThreads: threads.length,
    }
    return new CliExit(doc, 0)
  }

  const g = parseOrFail(readJsonFile(ctx, jsonPath, '--gdoc-json'))
  if (g.threads.length) {
    throw cliErr('BAD_REQUEST', `that Google Doc already has ${g.threads.length} comment(s); export-gdoc only comments on the new doc it just created`, {
      hint: 'read back the doc created from the upload copy, before anyone else touches it',
    })
  }
  const plan = planGdocComments(threads, g, ptext)
  writeOut(planPath, JSON.stringify({ file: at.rel, documentId: g.documentId ?? null, placed: plan.placed }, null, 1))
  const doc: ExportGdocComments = {
    ok: true, step: 'comments', file: at.rel, ...(g.documentId ? { documentId: g.documentId } : {}),
    requests: plan.requests,
    placed: plan.placed.map((p) => ({ ...p, replies: p.replies.length })),
    replies: plan.placed.reduce((n, p) => n + p.replies.length, 0),
    planPath,
  }
  return new CliExit(doc, 0)
}

// ---------------------------------------------------------------------------------------------------------------
// export-docx

export interface ExportDocxResult {
  ok: true
  file: string
  out: string
  comments: number
  replies: number
  /** Threads whose anchor is gone: kept as comments on the first paragraph. */
  general: number
}

export async function runExportDocx(ctx: Ctx): Promise<CliExit> {
  const at = locateFile(arg(ctx, 0, 'file'), ctx.io.cwd, opt(ctx, 'root'))
  const outArg = opt(ctx, 'out')
  const out = outArg !== undefined ? resolve(ctx.io.cwd, outArg) : at.abs.replace(/\.(md|markdown)$/i, '.docx')
  if (!/\.docx$/i.test(out)) throw cliErr('BAD_REQUEST', `--out must end in .docx, got ${out}`)
  if (existsSync(out) && !flag(ctx, 'overwrite')) throw cliErr('BAD_REQUEST', `${out} already exists`, { hint: 'pass --overwrite to replace it, or --out F for another name' })
  const { markdown, state } = await readReview(ctx, at)
  const md = await sharedMd()
  const L = load(md, markdown)
  const ptext = ptextOf(L.doc, L).text
  const threads = exportThreads(state.threads, state.suggestions, ptext, localUser(ctx).displayName)
  const built = buildDocx(L.doc, threads, { title: titleOf(markdown, at.abs), author: localUser(ctx).displayName })
  writeOut(out, built.bytes)
  const doc: ExportDocxResult = { ok: true, file: at.rel, out, comments: built.comments, replies: built.replies, general: built.general }
  return new CliExit(doc, 0)
}
