// web/src/handoff/platform.ts (Pass 4 #29). Which copy shortcut the page names in its own words. Read per call, so a
// test can stage another platform; the same Mac / iPhone / iPad test the editor toolbar uses for its tooltips.
type Nav = Pick<Navigator, 'platform' | 'userAgent'>

const browserNav = (): Nav | undefined => (typeof navigator === 'undefined' ? undefined : navigator)

/** macOS and iOS use Cmd; everything else (Windows, Linux, ChromeOS) uses Ctrl. */
export function isApplePlatform(nav: Nav | undefined = browserNav()): boolean {
  return /Mac|iPhone|iPad/.test(nav?.platform || nav?.userAgent || '')
}

/** The shortcut that copies the selected text, as people say it: "Cmd+C" or "Ctrl+C". */
export function copyShortcut(nav?: Nav): string {
  return isApplePlatform(nav) ? 'Cmd+C' : 'Ctrl+C'
}
