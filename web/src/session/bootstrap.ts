// web/src/session/bootstrap.ts (P2). readBootstrap: the <meta name="mdr-*"> tags P1 injects (CONTRACTS §12.0.2).
//
// A missing token or root throws (P3 renders "This page must be opened from `mdr open`"). An empty mdr-file means
// no ?file= (or an invalid one, with mdr-file-error naming why), which P3 renders as the empty state (§12.0.1).
import { ERROR_TABLE } from '../../../shared/types'
import type { ErrorCode, ReadBootstrap, SessionBootstrap } from '../../../shared/types'

function meta(doc: Document, name: string): string | null {
  const el = doc.querySelector(`meta[name="${name}"]`)
  const v = el?.getAttribute('content')
  return v === null || v === undefined ? null : v
}

export const readBootstrap: ReadBootstrap = (doc: Document): SessionBootstrap => {
  const token = meta(doc, 'mdr-token')
  const root = meta(doc, 'mdr-root')
  if (!token) throw new Error('mdr: <meta name="mdr-token"> is missing; this page must be opened from `mdr open`')
  if (!root) throw new Error('mdr: <meta name="mdr-root"> is missing; this page must be opened from `mdr open`')
  const portRaw = Number(meta(doc, 'mdr-port') ?? '')
  const protocolRaw = Number(meta(doc, 'mdr-protocol') ?? '')
  const file = meta(doc, 'mdr-file')
  const fileErrorRaw = meta(doc, 'mdr-file-error')
  const fileError: ErrorCode | null = fileErrorRaw && fileErrorRaw in ERROR_TABLE ? (fileErrorRaw as ErrorCode) : fileErrorRaw ? 'BAD_REQUEST' : null
  return {
    token,
    root,
    rootHash: meta(doc, 'mdr-root-hash') ?? '',
    port: Number.isInteger(portRaw) && portRaw > 0 ? portRaw : 0,
    file: file !== null && file !== '' && fileError === null ? file : null,
    fileError,
    version: meta(doc, 'mdr-version') ?? '',
    protocol: Number.isInteger(protocolRaw) ? protocolRaw : 0,
    schemaFingerprint: meta(doc, 'mdr-fingerprint') ?? '',
    testHooks: meta(doc, 'mdr-test-hooks') === '1',
  }
}
