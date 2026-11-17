// tests/unit/web/shell/helpers.tsx (P3): builders shared by P3's web unit tests (not a test file itself).
import type { CommentId, Message, ReviewState, Thread, ThreadId } from '../../../../shared/types'

export const tid = (n: number): ThreadId => `t_${String(n).padStart(26, '0')}`
export const cid = (n: number): CommentId => `c_${String(n).padStart(26, '0')}`

/** A markdown doc of `n` short paragraphs: "Paragraph <i> says something about topic <i>." */
export function paragraphs(n: number): string {
  return Array.from({ length: n }, (_, i) => `Paragraph ${i} says something about topic ${i}.`).join('\n\n') + '\n'
}

export function thread(n: number, o: { block: number; quote?: string; status?: Thread['status']; detached?: boolean; by?: Message['by']; body?: string; replies?: number; pos?: number } ): Thread {
  const quote = o.quote ?? `topic ${o.block}`
  const anchor = { kind: 'text' as const, quote, prefix: '', suffix: '', hint: { rev: 0, pos: o.pos ?? o.block * 100, block: o.block, blockHash: '0'.repeat(16), offsetInBlock: 0 } }
  const messages: Message[] = [{ id: cid(n * 10), by: o.by ?? 'TJ', at: '2026-10-15T12:00:00.000Z', body: o.body ?? `Comment ${n}`, seq: n * 10 }]
  for (let r = 1; r <= (o.replies ?? 0); r++) messages.push({ id: cid(n * 10 + r), by: r % 2 ? 'Claude' : 'TJ', at: '2026-10-15T12:01:00.000Z', body: `Reply ${r}`, seq: n * 10 + r })
  return {
    id: tid(n), kind: 'comment', status: o.status ?? 'open', autoResolved: false, anchor, lastAnchor: anchor,
    resolution: { state: o.detached ? 'detached' : 'exact', from: o.pos ?? o.block * 100, to: (o.pos ?? o.block * 100) + quote.length },
    detached: o.detached ?? false, createdBy: o.by ?? 'TJ', createdSeq: n * 10, lastSeq: n * 10, messages, suggestions: [], unread: 0,
  }
}

export function reviewWith(threads: Thread[], file = 'doc.md'): Partial<ReviewState> {
  return { file, threads }
}

/** A manual requestAnimationFrame queue. */
export function frameQueue() {
  const q: Array<() => void> = []
  return {
    raf: (cb: () => void): number => q.push(cb),
    caf: (): void => undefined,
    run(): void {
      for (const f of q.splice(0)) f()
    },
    get size() {
      return q.length
    },
  }
}
