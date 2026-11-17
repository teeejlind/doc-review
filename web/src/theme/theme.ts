// web/src/theme/theme.ts (P3; CONTRACTS §12.0.1, §12.2.2, R7.1).
//
// Dark mode follows the system (prefers-color-scheme) unless a theme is forced: `?theme=light|dark` on the URL
// (handy for captures) or localStorage `mdr:theme`. A forced theme sets data-theme on <html>, which tokens.css
// honours (:root[data-theme]); the effective theme is mirrored on #mdr-app[data-theme] either way (§12.0.1) and kept
// current when the system theme changes.
export type ThemeName = 'light' | 'dark'

const STORAGE_KEY = 'mdr:theme'

const asTheme = (v: string | null | undefined): ThemeName | null => (v === 'light' || v === 'dark' ? v : null)

/** The forced theme, if any: URL first, then localStorage (try/catch: storage can throw or be absent). */
export function forcedTheme(loc: Pick<Location, 'search'> | null, storage: Pick<Storage, 'getItem'> | null): ThemeName | null {
  const fromUrl = asTheme(loc ? new URLSearchParams(loc.search).get('theme') : null)
  if (fromUrl) return fromUrl
  try {
    return asTheme(storage?.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export interface ThemeEnv {
  doc: Document
  app: HTMLElement | null
  matchMedia?: ((q: string) => MediaQueryList) | null
  loc?: Pick<Location, 'search'> | null
  storage?: Pick<Storage, 'getItem'> | null
}

/** Applies the theme now and follows the system; returns the effective theme and a disposer. */
export function installTheme(env: ThemeEnv): { theme: () => ThemeName; dispose: () => void } {
  const win = env.doc.defaultView
  const mm = env.matchMedia === undefined ? (win?.matchMedia?.bind(win) ?? null) : env.matchMedia
  let storage: Pick<Storage, 'getItem'> | null = null
  if (env.storage !== undefined) storage = env.storage
  else {
    try {
      storage = win?.localStorage ?? null
    } catch {
      storage = null
    }
  }
  const forced = forcedTheme(env.loc === undefined ? (win?.location ?? null) : env.loc, storage)
  const query = mm ? mm('(prefers-color-scheme: dark)') : null
  const effective = (): ThemeName => forced ?? (query?.matches ? 'dark' : 'light')
  const apply = (): void => {
    if (forced) env.doc.documentElement.dataset.theme = forced
    else delete env.doc.documentElement.dataset.theme
    if (env.app) env.app.dataset.theme = effective()
  }
  apply()
  const onChange = (): void => apply()
  query?.addEventListener?.('change', onChange)
  return { theme: effective, dispose: () => query?.removeEventListener?.('change', onChange) }
}
