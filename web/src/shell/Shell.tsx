// web/src/shell/Shell.tsx (P3; CONTRACTS §12.0.1, §12.0.3, §12.2.4, §11.3, §11.4, §11.7, §12.4, §12.10, §12.14, §10).
//
// The page shell rendered into #mdr-app once a session exists. It owns every element of §12.0.1 and keeps the
// host ids P2 mounts into (#mdr-toolbar-host, #mdr-scroll, #mdr-editor-host). In a layout effect, once those
// hosts exist, it calls createEditor({ host, toolbarHost, scrollContainer, session }); on unmount it destroys the
// editor, then closes the session (which flushes). With the editor it wires:
//   - #mdr-app[data-mode] from bridge.getMode() / onModeChange (§12.2.4; P2 never touches #mdr-app), and
//     #mdr-app[data-narrow] below NARROW_BREAKPOINT_PX;
//   - quiet chrome: --mdr-chrome-opacity on #mdr-app and data-quiet on the top bar;
//   - the top bar: Comment and next/prev (one selection watch, reaching the rail through a command hub), the save
//     chip, the History button, the Claude badge and Send to Claude;
//   - the rail (RailView) inside aside.mdr-rail, or in narrow mode the bottom sheet in the sheet host;
//   - the banner slot: the session's banner and the recovered-draft card (§12.14), on screen wherever TJ is;
//   - toasts for session notices, editor notices and Send (§12.10, §12.14), the clipboard-refused modal, and the
//     history panel (§10);
//   - the file strip under the top bar's row (where the document lives: Reveal in Finder, Copy path);
//   - the mdr:ready mark (§11.7).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TESTID } from '../../../shared/constants'
import type { CreateEditor, DocSession, EditorHandle, SessionBanner } from '../../../shared/types'
import { createHandoffController } from '../handoff/controller'
import { ClaudeBadge, PromptModal, SendButton } from '../handoff/HandoffControls'
import { ExportMenu } from '../handoff/ExportMenu'
import { restoredText } from '../history/diff-view'
import { HistoryPanel } from '../history/HistoryPanel'
import { useNarrow } from '../narrow/narrow'
import { createCommandHub } from '../rail/commands'
import { RailView, type RailViewProps } from '../rail/RailView'
import { applyQuietChrome, createQuietChrome } from '../theme/quiet-chrome'
import { RecoveredCard, useRecoveredDraft } from '../threads/RecoveredCard'
import { createSelectionWatch } from '../threads/selection'
import { TopbarThreads } from '../threads/TopbarThreads'
import { useIdentityWatch } from '../useIdentity'
import { Banner } from './Banner'
import { EDITOR_FAILED, EmptyState } from './EmptyState'
import { FileStrip } from './FileStrip'
import { createReadyMark, type ReadyMarkOptions } from './ready'
import { SaveChip } from './SaveChip'
import { ShellLayout } from './ShellLayout'
import { createToastStore, type ToastStore } from './toast-store'
import { Toasts, useNoticeToasts } from './Toasts'
import './shell.css'

export interface ShellProps {
  session: DocSession
  createEditor: CreateEditor
  /** #mdr-app (the React root container; carries data-mode, data-theme and the chrome token). */
  app: HTMLElement | null
  /** Called once the editor exists (tests). */
  onEditor?: (e: EditorHandle) => void
  /** Test seams for the rail scheduler. */
  railOptions?: RailViewProps['schedulerOptions']
  onRailFrame?: RailViewProps['onFrame']
  reload?: () => void
  /** Test seams: the toast store, the narrow-mode window, the ready mark. */
  toasts?: ToastStore
  narrowWindow?: Parameters<typeof useNarrow>[0]
  readyOptions?: Partial<ReadyMarkOptions>
}

export function Shell({ session, createEditor, app, onEditor, railOptions, onRailFrame, reload, toasts: toastsProp, narrowWindow, readyOptions }: ShellProps) {
  const toolbarHost = useRef<HTMLDivElement>(null)
  const editorHost = useRef<HTMLDivElement>(null)
  const topbar = useRef<HTMLElement>(null)
  const historyBtn = useRef<HTMLButtonElement>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [railEl, setRailEl] = useState<HTMLElement | null>(null)
  const [sheetEl, setSheetEl] = useState<HTMLDivElement | null>(null)
  const [editor, setEditor] = useState<EditorHandle | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [banner, setBanner] = useState<SessionBanner | null>(() => session.getBanner())
  const [historyOpen, setHistoryOpen] = useState(false)
  const onEditorRef = useRef(onEditor)
  onEditorRef.current = onEditor
  const recovered = useRecoveredDraft(session)
  // `mdr config set name` while the page is open: the cards, replies and copied prompt pick the new name up without a reload
  useIdentityWatch(session)
  const hub = useMemo(() => createCommandHub(), [])
  const selection = useMemo(() => (editor ? createSelectionWatch({ bridge: editor.bridge }) : null), [editor])
  useEffect(() => () => selection?.destroy(), [selection])
  const ownToasts = useMemo(() => createToastStore(), [])
  const toasts = toastsProp ?? ownToasts
  const handoff = useMemo(
    () => createHandoffController({ session, toasts, unsent: { has: () => hub.commands.hasUnsent(), post: () => hub.commands.postUnsent() } }),
    [session, toasts, hub],
  )
  useEffect(() => () => handoff.destroy(), [handoff])
  useNoticeToasts(toasts, session, editor?.bridge ?? null, { onViewHistory: () => setHistoryOpen(true) })

  const narrow = useNarrow(narrowWindow)
  const narrowRef = useRef(narrow)
  narrowRef.current = narrow
  useEffect(() => {
    if (app) app.dataset.narrow = String(narrow)
  }, [app, narrow])

  // §11.7: mdr:ready once P2's editor-ready mark and a complete rail layout (none needed in narrow mode) exist
  const readyRef = useRef(readyOptions)
  const ready = useMemo(() => createReadyMark({ needsRail: () => !narrowRef.current, ...(readyRef.current ?? {}) }), [])
  useEffect(() => () => ready.destroy(), [ready])
  useEffect(() => {
    if (editor) ready.editorCreated()
  }, [editor, ready])
  useEffect(() => ready.check(), [narrow, ready])

  useEffect(() => {
    setBanner(session.getBanner())
    return session.subscribe((what) => {
      if (what === 'banner') setBanner(session.getBanner())
    })
  }, [session])

  // §12.0.3: createEditor once #mdr-editor-host, #mdr-toolbar-host and #mdr-scroll exist.
  useLayoutEffect(() => {
    const host = editorHost.current
    const toolbar = toolbarHost.current
    if (!host || !toolbar || !scrollEl) return undefined
    let disposed = false
    let handle: EditorHandle | null = null
    createEditor({ host, toolbarHost: toolbar, scrollContainer: scrollEl, session }).then(
      (e) => {
        if (disposed) {
          e.destroy()
          return
        }
        handle = e
        setEditor(e)
        onEditorRef.current?.(e)
      },
      (err: unknown) => {
        if (disposed) return
        console.error('[mdr] createEditor failed', err)
        setFailure(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      disposed = true
      handle?.destroy()
      setEditor(null)
      void session.close()
    }
  }, [session, createEditor, scrollEl])

  // §12.2.4: data-mode on #mdr-app, from the bridge.
  useEffect(() => {
    if (!editor || !app) return undefined
    app.dataset.mode = editor.bridge.getMode()
    return editor.bridge.onModeChange((m) => {
      app.dataset.mode = m
    })
  }, [editor, app])

  // the top bar is one row on a wide window and two on a narrow one: fixed-position panels under it (version history)
  // start at its real bottom edge, not at a fixed 48 px
  useEffect(() => {
    const bar = topbar.current
    if (!app || !bar) return undefined
    const write = (): void => void app.style.setProperty('--shell-topbar-height', `${Math.round(bar.getBoundingClientRect().height)}px`)
    write()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(write)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [app])

  // §12.2.4: quiet chrome.
  useEffect(() => {
    if (!editor) return undefined
    const q = createQuietChrome({ bridge: editor.bridge, apply: (quiet) => applyQuietChrome(app, topbar.current, quiet) })
    return () => {
      q.destroy()
      applyQuietChrome(app, topbar.current, false)
    }
  }, [editor, app])

  const closeHistory = (): void => {
    setHistoryOpen(false)
    historyBtn.current?.focus({ preventScroll: true })
  }

  return (
    <ShellLayout
      topbarRef={topbar}
      toolbarRef={toolbarHost}
      scrollRef={setScrollEl}
      editorHostRef={editorHost}
      railRef={setRailEl}
      sheetRef={setSheetEl}
      strip={<FileStrip session={session} toasts={toasts} />}
      actions={
        <>
          {/* the document's name lives in the file strip under this row (FileStrip, TESTID.docName), which leaves this row
              room for the mode pill at desktop widths */}
          {/* first among the controls, so a badge appearing takes the free space at the row's left and moves nothing else */}
          <ClaudeBadge session={session} controller={handoff} onShowUnread={() => hub.commands.firstUnread()} />
          {editor && selection ? <TopbarThreads commands={hub.commands} selection={selection} navCount={hub.navCount} /> : null}
          <SaveChip session={session} onConflict={() => hub.commands.firstConflict()} />
          <button
            type="button"
            ref={historyBtn}
            className="mdr-icon-button mdr-history-button"
            data-testid={TESTID.historyButton}
            aria-label="Version history"
            aria-haspopup="dialog"
            aria-expanded={historyOpen ? 'true' : 'false'}
            title="Version history"
            onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M2.5 2.6v2.6h2.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 5.2V8l2 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <ExportMenu controller={handoff} />
          <SendButton controller={handoff} bridge={editor?.bridge ?? null} />
        </>
      }
      banner={
        banner || recovered ? (
          <>
            {banner ? <Banner banner={banner} session={session} /> : null}
            {recovered ? <RecoveredCard draft={recovered} session={session} /> : null}
          </>
        ) : null
      }
      docBefore={failure ? <EmptyState reason={EDITOR_FAILED} file={session.file} detail={failure} onReload={reload ?? (() => location.reload())} /> : null}
      rail={
        editor && scrollEl && railEl && selection ? (
          <RailView
            bridge={editor.bridge}
            session={session}
            container={scrollEl}
            rail={railEl}
            content={editorHost.current}
            selection={selection}
            commands={hub}
            narrow={narrow}
            sheetHost={sheetEl}
            onLayoutComplete={(complete) => ready.railFrame(complete)}
            onToast={(t) => void toasts.show(t)}
            {...(onRailFrame ? { onFrame: onRailFrame } : {})}
            {...(railOptions ? { schedulerOptions: railOptions } : {})}
          />
        ) : null
      }
      overlays={
        <>
          <Toasts store={toasts} />
          <PromptModal controller={handoff} />
          {historyOpen ? (
            <HistoryPanel
              session={session}
              onClose={closeHistory}
              onRestored={(r, v) => void toasts.show({ code: 'HISTORY_RESTORED', kind: r.detached.length || r.staled.length ? 'warn' : 'info', text: restoredText(v, r) })}
            />
          ) : null}
        </>
      }
    />
  )
}
