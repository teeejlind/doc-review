// web/src/rail/commands.ts (P3; CONTRACTS §11.4, §11.5).
//
// The rail's verbs, for callers outside the rail: the top bar's Comment and next/prev buttons, the Claude badge and
// the save chip. RailView binds the
// implementation while it is mounted; until then (and after it unmounts) every command is a no-op.
import type { SelectionTarget, Unsubscribe } from '../../../shared/types'

export interface RailCommands {
  /** Open the composer: for a selection target, or 'doc' for a whole-doc comment. */
  comment(target: Exclude<SelectionTarget, null> | 'doc'): void
  /** Next / previous comment (§11.4: scroll the anchor to 30%, then activate). */
  nav(dir: 1 | -1): void
  /** The Claude badge's "Claude replied": go to the first card with unread messages (§8.5). */
  firstUnread(): void
  /** The save chip's "Conflict (n)": go to the first conflict or unsaveable card (§12.4). */
  firstConflict(): void
  /** Something typed in a composer and not posted: a reply, a new comment, a whole-doc comment. */
  hasUnsent(): boolean
  /** Post all of it (Send to Claude does this before it hands over). false = something didn't post and stays in its box. */
  postUnsent(): Promise<boolean>
}

/** How many comments Previous / Next can reach right now; null until the rail has said (the buttons stay enabled). */
export interface NavCount {
  get(): number | null
  subscribe(cb: () => void): Unsubscribe
}

export interface CommandHub {
  readonly commands: RailCommands
  readonly navCount: NavCount
  bind(impl: RailCommands): Unsubscribe
  /** The rail publishes the number of comments next/prev can reach (the top bar disables them at 0). */
  setNavCount(n: number | null): void
}

export function createCommandHub(): CommandHub {
  let impl: RailCommands | null = null
  let count: number | null = null
  const subs = new Set<() => void>()
  return {
    commands: {
      comment: (t) => impl?.comment(t),
      nav: (d) => impl?.nav(d),
      firstUnread: () => impl?.firstUnread(),
      firstConflict: () => impl?.firstConflict(),
      hasUnsent: () => impl?.hasUnsent() ?? false,
      postUnsent: () => impl?.postUnsent() ?? Promise.resolve(true),
    },
    navCount: {
      get: () => count,
      subscribe(cb) {
        subs.add(cb)
        return () => subs.delete(cb)
      },
    },
    setNavCount(n) {
      if (count === n) return
      count = n
      for (const cb of [...subs]) cb()
    },
    bind(next) {
      impl = next
      return () => {
        if (impl === next) impl = null
      }
    },
  }
}
