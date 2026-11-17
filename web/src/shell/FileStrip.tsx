// web/src/shell/FileStrip.tsx (onboarding). The "where's my file" strip: one quiet row at the bottom of the top bar with
// the document's folder and name (the name carries TESTID.docName: it moved here from the top bar's actions row), a Reveal button (Finder / Explorer / the file manager) and Copy path.
//
// The absolute path is the server's (DocSnapshot.abs, a realpath in the OS's own separators), so Copy path pastes
// straight into Finder's Go to Folder or Explorer's address bar. The folder reads with the home folder as `~` on macOS
// and Linux (a cheap prefix rule; Windows keeps the full path) and ellipsizes from the left, so its last folders stay
// in view; the full path is the tooltip. In narrow mode (CSS, below 640 px) the folder text goes and the buttons keep
// only their icons (each keeps its aria-label). Reveal posts /api/reveal through the session; a session without
// revealFile (a test fake) shows no Reveal button.
import { useEffect, useRef, useState } from 'react'
import { TESTID } from '../../../shared/constants'
import type { DocSession } from '../../../shared/types'
import { isMac } from '../platform'
import type { ToastStore } from './toast-store'

export interface FileLocation {
  /** Absolute path of the file, native separators. */
  abs: string
  /** The file's name. */
  name: string
  /** The folder as shown: `~` for the home folder where that is known. */
  dirShown: string
  /** The folder in full (tooltip). */
  dir: string
  windows: boolean
}

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** Where the session's document lives, from the server's absolute path (or root + file when a fake has none). */
export function fileLocation(abs: string | undefined, root: string, file: string): FileLocation {
  const windows = isWindowsPath(abs || root)
  const sep = windows ? '\\' : '/'
  const full = abs || (root.replace(/[\\/]+$/, '') + sep + (windows ? file.replace(/\//g, '\\') : file))
  const cut = Math.max(full.lastIndexOf('/'), windows ? full.lastIndexOf('\\') : -1)
  const dir = cut > 0 ? full.slice(0, cut) : cut === 0 ? sep : full
  const name = cut >= 0 ? full.slice(cut + 1) : full
  const dirShown = windows ? dir : dir.replace(/^\/(?:Users\/(?!Shared(?:\/|$))[^/]+|home\/[^/]+)(?=\/|$)/, '~')
  return { abs: full, name, dir, dirShown, windows }
}

/** The Reveal button's words on this platform. */
export function revealLabel(windows: boolean): { label: string; app: string } {
  if (windows) return { label: 'Show in Explorer', app: 'File Explorer' }
  if (isMac()) return { label: 'Reveal in Finder', app: 'Finder' }
  return { label: 'Show in folder', app: 'the file manager' }
}

export interface FileStripProps {
  session: DocSession
  toasts: ToastStore
}

export function FileStrip({ session, toasts }: FileStripProps) {
  let abs: string | undefined
  try {
    abs = session.getSnapshot().abs
  } catch {
    abs = undefined
  }
  const loc = fileLocation(abs, session.root, session.file)
  const reveal = revealLabel(loc.windows)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const flash = (s: 'copied' | 'failed'): void => {
    setCopied(s)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied('idle'), 1800)
  }

  const onCopy = (): void => {
    let p: Promise<void>
    try {
      const c = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
      p = c ? c.writeText(loc.abs) : Promise.reject(new Error('no clipboard'))
    } catch (e) {
      p = Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
    p.then(
      () => flash('copied'),
      () => {
        flash('failed')
        void toasts.show({ code: 'FILE_PATH_COPY_FAILED', kind: 'warn', text: `Couldn't copy the path. It is ${loc.abs}` })
      },
    )
  }

  const revealFile = session.revealFile?.bind(session)
  const onReveal = (): void => {
    if (!revealFile) return
    revealFile().catch(() => {
      void toasts.show({ code: 'FILE_REVEAL_FAILED', kind: 'error', text: `Couldn't open ${reveal.app}. Use Copy path instead.` })
    })
  }

  const copyText = copied === 'copied' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy path'
  return (
    <div className="mdr-file-strip" data-testid={TESTID.fileStrip} role="group" aria-label="File location">
      <span className="mdr-file-strip-path" title={loc.abs}>
        <svg className="mdr-file-strip-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.5 1.5H13c.69 0 1.25.56 1.25 1.25v6.25c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        <span className="mdr-file-strip-dir" data-role="dir">
          <bdi dir="ltr">{loc.dirShown}</bdi>
        </span>
        <span className="mdr-file-strip-sep" aria-hidden="true">{loc.windows ? '\\' : '/'}</span>
        <span className="mdr-file-strip-name" data-role="name" data-testid={TESTID.docName} title={loc.abs}>{loc.name}</span>
        <span className="mdr-visually-hidden">{` in ${loc.dir}`}</span>
      </span>
      <span className="mdr-file-strip-actions">
        {revealFile ? (
          <button type="button" className="mdr-file-strip-button" data-testid={TESTID.fileStripReveal} aria-label={reveal.label} title={reveal.label} onClick={onReveal}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M9 2.75h4.25V7M13.25 2.75 7.5 8.5M11.5 9.5v3c0 .41-.34.75-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5c0-.41.34-.75.75-.75h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="mdr-file-strip-label">{reveal.label}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="mdr-file-strip-button"
          data-testid={TESTID.fileStripCopy}
          data-state={copied}
          aria-label={copied === 'idle' ? 'Copy path' : copyText}
          title={`Copy ${loc.abs}`}
          onClick={onCopy}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            {copied === 'copied' ? (
              <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <rect x="5.25" y="5.25" width="8" height="8.5" rx="1.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <path d="M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25H4c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h1.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </>
            )}
          </svg>
          <span className="mdr-file-strip-label">{copyText}</span>
        </button>
      </span>
      <span className="mdr-visually-hidden" aria-live="polite">{copied === 'copied' ? 'Path copied' : copied === 'failed' ? "Couldn't copy the path" : ''}</span>
    </div>
  )
}
