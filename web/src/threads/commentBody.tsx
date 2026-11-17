// web/src/threads/commentBody.tsx (QA round 1: confirmed 34). A comment's text with light inline rendering: `code`,
// **bold**, [text](url), bare http(s) links and "- " bullet lines. Everything else stays as typed (pre-wrap), and a link
// is only ever http(s) or mailto, opened in a new tab.
import type { ReactNode } from 'react'

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

const SAFE = /^(https?:\/\/|mailto:)[^\s<>"]+$/i
// `code` | **bold** | [text](url) | bare url
const TOKEN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"]+)/g

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  const text = (t: string): void => {
    if (!t) return
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.text += t
    else out.push({ kind: 'text', text: t })
  }
  let at = 0
  for (const m of s.matchAll(TOKEN)) {
    text(s.slice(at, m.index))
    at = m.index + m[0].length
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] })
    else if (m[3] !== undefined && m[4] !== undefined) {
      if (SAFE.test(m[4])) out.push({ kind: 'link', text: m[3], href: m[4] })
      else text(m[0])
    } else if (m[5] !== undefined) {
      // trailing sentence punctuation isn't part of the address
      const url = m[5].replace(/[.,;:!?)\]]+$/, '')
      out.push({ kind: 'link', text: url, href: url })
      text(m[5].slice(url.length))
    }
  }
  text(s.slice(at))
  return out
}

function inline(parts: Inline[]): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.kind) {
      case 'bold':
        return <strong key={i}>{p.text}</strong>
      case 'code':
        return <code key={i}>{p.text}</code>
      case 'link':
        return (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
            {p.text}
          </a>
        )
      default:
        return p.text
    }
  })
}

export function CommentBody({ text }: { text: string }) {
  const lines = text.split('\n')
  if (lines.length === 1) return <>{inline(parseInline(text))}</>
  return (
    <>
      {lines.map((line, i) => {
        const bullet = /^\s*[-*] +(.*)$/.exec(line)
        if (bullet) {
          return (
            <span key={i} className="mdr-body-line mdr-body-line--bullet">
              {inline(parseInline(bullet[1]!))}
            </span>
          )
        }
        if (!line.trim()) return <span key={i} className="mdr-body-line mdr-body-line--blank" />
        return (
          <span key={i} className="mdr-body-line">
            {inline(parseInline(line))}
          </span>
        )
      })}
    </>
  )
}
