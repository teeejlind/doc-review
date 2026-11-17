// web/src/threads/clipboard.ts (P3). Clipboard writes from card buttons (Copy replacement, Copy markdown). Call
// inside the click handler, before any await, so the write runs in the user gesture. Resolves false when the browser
// refuses it (no permission, insecure context, no clipboard API).
export async function copyText(text: string, clipboard: Pick<Clipboard, 'writeText'> | null = typeof navigator !== 'undefined' ? (navigator.clipboard ?? null) : null): Promise<boolean> {
  if (!clipboard) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
