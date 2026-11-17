// tests/helpers/sse.ts (integrator, day 0). A spec-conformant text/event-stream parser over a web ReadableStream, shared
// by webClient.events() (§2.5), MockTransport.events() (§12.0.5) and the waiter-stream helpers. Browser-safe: no node:*.
//
// Per the HTML spec: lines end in \n, \r\n or \r; `field: value` (one leading space stripped); `data` lines join with
// \n; a blank line dispatches; `:`-prefixed lines are comments (the server's `: hb` heartbeat, §8.6), surfaced as
// `{ comment }` frames so callers can assert heartbeats or feed a watchdog.

export interface SseMessage {
  /** `event:` field; 'message' when absent. */
  event: string
  data: string
  /** Last `id:` seen (sticky across messages, as EventSource's lastEventId). */
  id: string
}
export type SseFrame = { kind: 'message'; message: SseMessage } | { kind: 'comment'; comment: string }

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event = ''
  let data: string[] = []
  let lastId = ''
  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (;;) {
        const m = /\r\n|\n|\r/.exec(buf)
        if (!m) break
        // a lone \r at the very end may be the first half of \r\n: wait for more input
        if (m[0] === '\r' && m.index === buf.length - 1) break
        const line = buf.slice(0, m.index)
        buf = buf.slice(m.index + m[0].length)
        if (line === '') {
          if (data.length > 0 || event !== '') {
            yield { kind: 'message', message: { event: event || 'message', data: data.join('\n'), id: lastId } }
          }
          event = ''
          data = []
          continue
        }
        if (line.startsWith(':')) {
          yield { kind: 'comment', comment: line.slice(1).trimStart() }
          continue
        }
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
        else if (field === 'id') lastId = value
        // `retry` and unknown fields are ignored
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // a pending read after cancel; nothing to release
    }
  }
}

/** Serialize one SSE message (what a server writes). */
export function formatSse(m: { event?: string; data: string; id?: string }): string {
  let s = ''
  if (m.event) s += `event: ${m.event}\n`
  if (m.id !== undefined) s += `id: ${m.id}\n`
  for (const line of m.data.split('\n')) s += `data: ${line}\n`
  return s + '\n'
}
