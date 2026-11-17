// server/routes/write.ts (P1). The browser write routes (actor TJ; CONTRACTS §8.3, §3.9, D32):
//   POST /api/save · /api/flush · /api/threads · /api/threads/:id/replies · /api/threads/:id/resolve|reopen
//   PATCH /api/comments/:id · POST /api/comments/:id/delete
//   POST /api/suggestions/:id/accept|reject|reopen · /api/suggestions/bulk
//   POST /api/policy · /api/read-marker · /api/history/restore
// (POST /api/handoff is the handoff module's, P4.) The §8.1 middleware has run: token, Origin, X-MDR-Client-Id and the
// body (parsed, no identity fields). Each route validates its body against shared/schemas.ts (BAD_REQUEST on a
// mismatch, so `SaveRequest.suggestions.reopen` is refused) and calls the store with the request's TjCtx, which the
// store stamps on the commit's StoreChanges; the SSE fan-out then echoes the clientId on doc-changed and
// sidecar-changed. A StoreError becomes the ApiError envelope in app.ts's onError, `review` overlaid by withHandoff.
// A recorded doc that vanished is DOC_GONE, except for a `cause: 'recreate'` save and a beacon flush, which reach the
// store (§3.6 recreate; a flush of a gone doc is still a flush).
import { Hono } from 'hono'
import type {
  BulkDecisionRequest, CreateThreadRequest, DecideRequest, EditCommentRequest, OpKeyRequest, PolicyRequest,
  ReadMarkerRequest, ReplyRequest, RestoreRequest, SaveRequest,
} from '../../shared/types'
import * as S from '../../shared/schemas'
import { isCommentId, isSuggestionId, isThreadId } from '../../shared/ids'
import type { ServerEnv } from '../security'
import { bodyOf, idParam, parseBody, resolveFile, tjCtxOf, type RouteCtx } from './context'

export function writeRoutes(ctx: RouteCtx): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>()
  const known = (file: string): boolean => ctx.hasStore(file)
  const file = (raw: string | undefined, allowGone = false): string => resolveFile(ctx.root, raw, { allowGone, known })

  app.post('/api/save', async (c) => {
    const req = parseBody<SaveRequest>(S.SaveRequestSchema, bodyOf(c), 'SaveRequest')
    const f = file(c.req.query('file'), req.cause === 'recreate')
    return c.json(await (await ctx.store(f)).save(req, tjCtxOf(c)))
  })

  app.post('/api/flush', async (c) => {
    parseBody(S.FlushRequestSchema, bodyOf(c), 'FlushRequest')
    const store = await ctx.store(file(c.req.query('file'), true))
    await store.flushTjSession('beacon')
    return c.json({ ok: true as const })
  })

  app.post('/api/threads', async (c) => {
    const req = parseBody<CreateThreadRequest>(S.CreateThreadRequestSchema, bodyOf(c), 'CreateThreadRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.createThread(req, tjCtxOf(c)))
  })

  app.post('/api/threads/:id/replies', async (c) => {
    const id = idParam(c, isThreadId, 'thread')
    const req = parseBody<ReplyRequest>(S.ReplyRequestSchema, bodyOf(c), 'ReplyRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.reply(id, req, tjCtxOf(c)))
  })

  for (const verb of ['resolve', 'reopen'] as const) {
    app.post(`/api/threads/:id/${verb}`, async (c) => {
      const id = idParam(c, isThreadId, 'thread')
      const req = parseBody<OpKeyRequest>(S.OpKeyRequestSchema, bodyOf(c), 'OpKeyRequest')
      const store = await ctx.store(file(c.req.query('file')))
      return c.json(await (verb === 'resolve' ? store.tj.resolve(id, req, tjCtxOf(c)) : store.tj.reopen(id, req, tjCtxOf(c))))
    })
  }

  app.patch('/api/comments/:id', async (c) => {
    const id = idParam(c, isCommentId, 'comment')
    const req = parseBody<EditCommentRequest>(S.EditCommentRequestSchema, bodyOf(c), 'EditCommentRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.editComment(id, req, tjCtxOf(c)))
  })

  app.post('/api/comments/:id/delete', async (c) => {
    const id = idParam(c, isCommentId, 'comment')
    const req = parseBody<OpKeyRequest>(S.OpKeyRequestSchema, bodyOf(c), 'OpKeyRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.deleteComment(id, req, tjCtxOf(c)))
  })

  app.post('/api/suggestions/bulk', async (c) => {
    const req = parseBody<BulkDecisionRequest>(S.BulkDecisionRequestSchema, bodyOf(c), 'BulkDecisionRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.bulkDecide(req, tjCtxOf(c)))
  })

  for (const verb of ['accept', 'reject', 'reopen'] as const) {
    app.post(`/api/suggestions/:id/${verb}`, async (c) => {
      const id = idParam(c, isSuggestionId, 'suggestion')
      const req = parseBody<DecideRequest>(S.DecideRequestSchema, bodyOf(c), 'DecideRequest')
      const store = await ctx.store(file(c.req.query('file')))
      return c.json(await (verb === 'reopen' ? store.tj.reopenSuggestion(id, req, tjCtxOf(c)) : store.tj.decide(id, verb, req, tjCtxOf(c))))
    })
  }

  app.post('/api/policy', async (c) => {
    const req = parseBody<PolicyRequest>(S.PolicyRequestSchema, bodyOf(c), 'PolicyRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.setPolicy(req, tjCtxOf(c)))
  })

  app.post('/api/read-marker', async (c) => {
    const req = parseBody<ReadMarkerRequest>(S.ReadMarkerRequestSchema, bodyOf(c), 'ReadMarkerRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.readMarker(req, tjCtxOf(c)))
  })

  app.post('/api/history/restore', async (c) => {
    const req = parseBody<RestoreRequest>(S.RestoreRequestSchema, bodyOf(c), 'RestoreRequest')
    return c.json(await (await ctx.store(file(c.req.query('file')))).tj.restore(req, tjCtxOf(c)))
  })

  return app
}
