// web/src/editor/assets.ts (Pass 4 #28). Where the page loads a markdown image from.
//
// `![x](./pic.png)` means the file beside the document, but the page lives at `/`, so the browser asked for /pic.png and
// got a 404. The image view asks GET /api/asset (CONTRACTS §8.3) instead, naming the document and the path in it. That
// is the view only: the node's `src` is untouched, so the saved markdown is too.

export interface AssetContext {
  /** The document, root-relative (it sets what a relative path is relative to). */
  file: string
  /** The page's token: an <img> can't send the Authorization header, so it rides the query like the event stream's. */
  token: string
}

/**
 * The URL for an image `src`, or null when the browser should load it as written: a web address, a data: or blob: URI,
 * a root path, a protocol-relative link, a #fragment. The browser reads a `?query` or `#fragment` off a path and decodes
 * %20 and friends before it reaches a file, so this does too.
 */
export function assetUrl(src: string, ctx: AssetContext): string | null {
  const s = src.trim()
  if (!s || /^[#/\\]/.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null
  const path = s.replace(/[?#][\s\S]*$/, '')
  if (!path) return null
  let rel = path
  try {
    rel = decodeURIComponent(path)
  } catch {
    // a stray % stays as typed
  }
  return `/api/asset?file=${encodeURIComponent(ctx.file)}&path=${encodeURIComponent(rel)}&t=${encodeURIComponent(ctx.token)}`
}
