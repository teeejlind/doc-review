// web/src/history/HistoryPanel.tsx (P3; CONTRACTS §10 UI, §11.6, §12.15 historyPanel / historyVersion / historyPick
// / historyDiff / historyRestore, §13 row 64, R5).
//
// Version history: a timeline of versions (newest first, the current text on top), an author-coloured diff of any two
// of them, and Restore on each version.
//   - From / To on every row pick the two ends of the diff (`mdr-history-pick`, data-role from|to). The default is
//     the newest version → the current text (or the version before it when the newest version IS the current text).
//   - The diff shows every changed block and one unchanged block either side; longer unchanged runs fold into a row
//     that opens on a click. A changed block is coloured by its last author (TJ, Claude, outside edit); insertions
//     are underlined and deletions struck through, so colour is never the only signal (§11.6).
//   - Restore calls session.history.restore(v). The session flushes, the server restores, and the editor adopts the
//     restored text before the promise resolves (§10, D47), so the panel closes on a document that already shows it.
//     A 409 STALE_REVISION (someone wrote since the list loaded) reloads the list and re-offers the restore.
// The panel is a non-modal dialog: Esc or the close button closes it and focus returns to the History button.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { TESTID } from '../../../shared/constants'
import type { DocSession, HistoryDiff, HistoryList, HistoryRef, RestoreResponse, VersionId, VersionMeta } from '../../../shared/types'
import { actorLabel, blockAuthor, blockKindOf, causeLabel, changeCount, cleanSegments, diffItems, plainBlockText, sideLabel, versionWhoLabel, whenLabel, type DiffItem } from './diff-view'
import './history.css'

export interface HistoryPanelProps {
  session: DocSession
  onClose(): void
  /** After a restore resolved (the panel then closes): the shell reports detached threads and stale suggestions. */
  onRestored?: (r: RestoreResponse, v: VersionId) => void
}

const codeOf = (e: unknown): string | null => {
  if (typeof e !== 'object' || e === null) return null
  const o = e as { code?: unknown; error?: { code?: unknown }; body?: { code?: unknown } }
  const c = o.code ?? o.error?.code ?? o.body?.code
  return typeof c === 'string' ? c : null
}
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The default pair for a freshly loaded list. */
export function defaultRange(list: Pick<HistoryList, 'versions' | 'unsnapshotted'>): { from: HistoryRef; to: HistoryRef } {
  const [newest, previous] = list.versions
  if (!newest) return { from: 'current', to: 'current' }
  return { from: list.unsnapshotted || !previous ? newest.v : previous.v, to: 'current' }
}

export function HistoryPanel({ session, onClose, onRestored }: HistoryPanelProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [list, setList] = useState<HistoryList | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [range, setRange] = useState<{ from: HistoryRef; to: HistoryRef } | null>(null)
  const [diff, setDiff] = useState<HistoryDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<VersionId | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const loadSeq = useRef(0)
  const diffSeq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => void (mounted.current = false), [])

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const l = await session.history.list()
      if (!mounted.current || seq !== loadSeq.current) return
      setList(l)
      setListError(null)
      setRange((cur) => {
        // keep TJ's picks while they still exist
        const has = (r: HistoryRef): boolean => r === 'current' || l.versions.some((v) => v.v === r)
        return cur && has(cur.from) && has(cur.to) ? cur : defaultRange(l)
      })
    } catch (e) {
      if (mounted.current && seq === loadSeq.current) setListError(`Couldn’t load the history: ${messageOf(e)}`)
    }
  }, [session])

  useEffect(() => {
    void load()
    // a write while the panel is open (TJ's autosave, Claude, an outside edit) adds versions
    let t: ReturnType<typeof setTimeout> | null = null
    const off = session.subscribe((what) => {
      if (what !== 'doc') return
      if (t) clearTimeout(t)
      t = setTimeout(() => void load(), 250)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [session, load])

  const from = range?.from
  const to = range?.to
  useEffect(() => {
    if (from === undefined || to === undefined) return
    const seq = ++diffSeq.current
    setDiffError(null)
    session.history.diff(from, to).then(
      (d) => {
        if (mounted.current && seq === diffSeq.current) setDiff(d)
      },
      (e: unknown) => {
        if (mounted.current && seq === diffSeq.current) {
          setDiff(null)
          setDiffError(`Couldn’t compare these versions: ${messageOf(e)}`)
        }
      },
    )
  }, [session, from, to, list?.currentRev])

  // focus lands in the panel on open
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('.mdr-history-close')?.focus({ preventScroll: true })
  }, [])

  const restore = async (v: VersionId): Promise<void> => {
    if (restoring) return
    setRestoring(v)
    setRestoreError(null)
    setNote(null)
    try {
      const r = await session.history.restore(v)
      onRestored?.(r, v)
      if (mounted.current) onClose()
    } catch (e) {
      if (!mounted.current) return
      if (codeOf(e) === 'STALE_REVISION') {
        setNote(`The document changed while this list was open. It now shows the latest text; restore ${v} again to use it.`)
        void load()
      } else setRestoreError(`Couldn’t restore ${v}: ${messageOf(e)}`)
    } finally {
      if (mounted.current) setRestoring(null)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      onClose()
    }
  }

  // nothing differs from the text on screen (a new document, or only its own first version): no timeline, no diff
  const nothingToCompare = list !== null && list.versions.every((v) => v.hash === list.currentHash)

  const pick = (role: 'from' | 'to', v: HistoryRef): void => setRange((cur) => ({ from: role === 'from' ? v : (cur?.from ?? v), to: role === 'to' ? v : (cur?.to ?? 'current') }))

  return (
    <div className="mdr-history" data-testid={TESTID.historyPanel} role="dialog" aria-modal="false" aria-labelledby={titleId} ref={panel} onKeyDown={onKeyDown}>
      {/* a div, not a <header>: inside the dialog a <header> would be a second banner landmark next to the top bar */}
      <div className="mdr-history-head">
        <h2 className="mdr-history-title" id={titleId}>
          Version history
        </h2>
        <button type="button" className="mdr-icon-button mdr-history-close" aria-label="Close version history" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {note ? (
        <p className="mdr-history-note" role="status">
          {note}
        </p>
      ) : null}
      {restoreError ? (
        <p className="mdr-history-note mdr-history-note--error" role="alert">
          {restoreError}
        </p>
      ) : null}
      {list && nothingToCompare ? (
        <p className="mdr-history-none">No earlier versions yet. A version is kept each time the document changes, so you can compare them or go back.</p>
      ) : (
        <div className="mdr-history-cols">
          <nav className="mdr-history-list" aria-label="Versions">
            {listError ? (
              <p className="mdr-history-empty" role="alert">
                {listError}
              </p>
            ) : !list ? (
              <p className="mdr-history-empty">Loading versions…</p>
            ) : (
              <ol className="mdr-history-rows">
                <VersionRow ref_="current" range={range} onPick={pick} label="Current version" detail={list.unsnapshotted ? 'Not in the history yet' : 'The text as it is now'} />
                {list.versions.map((v) => (
                  <VersionRow
                    key={v.v}
                    ref_={v.v}
                    meta={v}
                    range={range}
                    onPick={pick}
                    label={versionWhoLabel(v)}
                    detail={`${causeLabel(v)}${v.blocksChanged ? ` · ${v.blocksChanged} ${v.blocksChanged === 1 ? 'block' : 'blocks'} changed` : ''}`}
                    restoring={restoring}
                    isCurrentText={v.hash === list.currentHash}
                    onRestore={(x) => void restore(x)}
                  />
                ))}
              </ol>
            )}
          </nav>
          <DiffView diff={diff} error={diffError} loading={!diff && !diffError && range !== null} />
        </div>
      )}
    </div>
  )
}

interface VersionRowProps {
  ref_: HistoryRef
  meta?: VersionMeta
  range: { from: HistoryRef; to: HistoryRef } | null
  onPick(role: 'from' | 'to', v: HistoryRef): void
  label: string
  detail: string
  restoring?: VersionId | null
  isCurrentText?: boolean
  onRestore?(v: VersionId): void
}

function VersionRow(p: VersionRowProps) {
  const isFrom = p.range?.from === p.ref_
  const isTo = p.range?.to === p.ref_
  const name = p.meta ? p.meta.v : 'the current version'
  return (
    <li
      className="mdr-history-row"
      data-testid={TESTID.historyVersion}
      data-v={p.ref_}
      data-by={p.meta?.by ?? 'current'}
      data-from={String(isFrom)}
      data-to={String(isTo)}
    >
      <div className="mdr-history-row-main">
        <span className="mdr-history-dot" aria-hidden="true" />
        <span className="mdr-history-who">{p.label}</span>
        {p.meta ? <span className="mdr-history-v">{p.meta.v}</span> : null}
        {p.meta ? <time className="mdr-history-when" dateTime={p.meta.at}>{whenLabel(p.meta.at)}</time> : null}
        <span className="mdr-history-detail">{p.detail}</span>
      </div>
      <div className="mdr-history-row-actions" role="group" aria-label={`Use ${name}`}>
        <button
          type="button"
          className="mdr-history-pick"
          data-testid={TESTID.historyPick}
          data-role="from"
          data-v={p.ref_}
          aria-pressed={isFrom ? 'true' : 'false'}
          aria-label={`Compare from ${name}`}
          onClick={() => p.onPick('from', p.ref_)}
        >
          From
        </button>
        <button
          type="button"
          className="mdr-history-pick"
          data-testid={TESTID.historyPick}
          data-role="to"
          data-v={p.ref_}
          aria-pressed={isTo ? 'true' : 'false'}
          aria-label={`Compare to ${name}`}
          onClick={() => p.onPick('to', p.ref_)}
        >
          To
        </button>
        {p.meta && p.onRestore ? (
          <button
            type="button"
            className="mdr-history-restore"
            data-testid={TESTID.historyRestore}
            data-v={p.meta.v}
            disabled={!!p.restoring || p.isCurrentText}
            aria-label={p.restoring === p.meta.v ? 'Restoring…' : p.isCurrentText ? `Restore ${p.meta.v} (this is the current text)` : `Restore ${p.meta.v}`}
            title={p.isCurrentText ? 'This is the current text' : 'Replace the document with this version. Comments stay; the current text stays in the history.'}
            onClick={() => p.onRestore!(p.meta!.v)}
          >
            {p.restoring === p.meta.v ? 'Restoring…' : 'Restore'}
          </button>
        ) : null}
      </div>
    </li>
  )
}

export function DiffView({ diff, error, loading }: { diff: HistoryDiff | null; error: string | null; loading: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => setOpen(new Set()), [diff])
  const items = useMemo(() => (diff ? diffItems(diff.blocks) : []), [diff])
  const n = diff ? changeCount(diff.blocks) : 0
  const authors = useMemo(() => {
    const s = new Set<string>()
    for (const b of diff?.blocks ?? []) if (b.op !== 'equal') for (const a of b.by.length ? b.by : b.lastBy ? [b.lastBy] : []) s.add(a)
    return [...s]
  }, [diff])
  return (
    <section className="mdr-history-diff" data-testid={TESTID.historyDiff} aria-label="Changes between the picked versions" aria-busy={loading ? 'true' : 'false'}>
      {error ? (
        <p className="mdr-history-empty" role="alert">
          {error}
        </p>
      ) : !diff ? (
        <p className="mdr-history-empty">{loading ? 'Comparing…' : 'Pick two versions to compare.'}</p>
      ) : (
        <>
          <p className="mdr-history-diff-head">
            <span>
              From <strong>{sideLabel(diff.from)}</strong> to <strong>{sideLabel(diff.to)}</strong>
            </span>
            <span className="mdr-history-diff-count">
              {n === 0 ? 'No changes' : `${n} ${n === 1 ? 'block' : 'blocks'} changed`}
              {authors.length ? ` · by ${authors.map((a) => actorLabel(a as never)).join(', ')}` : ''}
            </span>
          </p>
          {n === 0 ? (
            <p className="mdr-history-empty">These two versions have the same text.</p>
          ) : (
            <div className="mdr-history-blocks">
              {items.map((it) =>
                it.type === 'fold' && !open.has(it.from) ? (
                  <button key={`f${it.from}`} type="button" className="mdr-hd-fold" aria-label={`Show ${it.count} unchanged ${it.count === 1 ? 'block' : 'blocks'}`} onClick={() => setOpen((s) => new Set([...s, it.from]))}>
                    {it.count} unchanged {it.count === 1 ? 'block' : 'blocks'}
                  </button>
                ) : it.type === 'fold' ? (
                  diff.blocks.slice(it.from, it.from + it.count).map((b, k) => <DiffBlockView key={`e${it.from + k}`} item={{ type: 'block', index: it.from + k, block: b, context: true }} />)
                ) : (
                  <DiffBlockView key={`b${it.index}`} item={it} />
                ),
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function DiffBlockView({ item }: { item: Extract<DiffItem, { type: 'block' }> }) {
  const b = item.block
  const who = blockAuthor(b)
  const others = b.by.filter((a) => a !== who)
  const kind = blockKindOf(b.after ?? b.before ?? '')
  // a replace is shown word by word; without the server's word diff, the whole old text then the whole new one
  const segs = b.op === 'replace' ? cleanSegments(b.before ?? '', b.after ?? '', b.inline?.length ? b.inline : [[-1, b.before ?? ''], [1, b.after ?? '']]) : []
  const onlyFormatting = b.op === 'replace' && !segs.some((s) => s.kind !== 'same')
  return (
    <div className="mdr-hd-block" data-op={b.op} data-by={who ?? 'none'} data-context={String(item.context)} data-kind={kind}>
      {b.op === 'equal' ? (
        <p className="mdr-hd-text">{plainBlockText(b.before ?? '')}</p>
      ) : b.op === 'insert' ? (
        <p className="mdr-hd-text">
          <ins>
            <span className="mdr-visually-hidden">Inserted: </span>
            {plainBlockText(b.after ?? '')}
          </ins>
        </p>
      ) : b.op === 'delete' ? (
        <p className="mdr-hd-text">
          <del>
            <span className="mdr-visually-hidden">Deleted: </span>
            {plainBlockText(b.before ?? '')}
          </del>
        </p>
      ) : (
        <p className="mdr-hd-text">
          {segs.map((s, i) =>
            s.kind === 'same' ? (
              <span key={i}>{s.text}</span>
            ) : s.kind === 'del' ? (
              <del key={i}>
                <span className="mdr-visually-hidden">Deleted: </span>
                {s.text}
              </del>
            ) : (
              <ins key={i}>
                <span className="mdr-visually-hidden">Inserted: </span>
                {s.text}
              </ins>
            ),
          )}
        </p>
      )}
      {onlyFormatting ? <span className="mdr-hd-by">Formatting changed</span> : null}
      {b.op !== 'equal' && who ? (
        <span className="mdr-hd-by">
          {actorLabel(who)}
          {others.length ? ` (also ${others.map(actorLabel).join(', ')})` : ''}
        </span>
      ) : null}
    </div>
  )
}
