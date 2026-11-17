- **Any `.md` that changes hands for feedback — either direction — goes through `doc-review`** (the skill in
  `integrations/skill/`, on the `mdr` CLI): a draft/brief/plan I hand the user to mark up, or an agency/vendor
  document they hand me to "review," "mark up," "comment on," "redline" or "give notes on." Never a chat paste of a
  long document, and never an in-place rewrite of someone else's draft — that destroys the user's ability to see what
  changed and why, which is the review. Read the skill first; `mdr` prints one JSON result per command and its exit
  codes say what to do next.
  - **mdr setup (one time, optional).** mdr ships generic: it protects nothing beyond `/` and `$HOME`, and names the
    human from git or the OS. To keep sensitive folders out of reach, set them in the environment
    (`~/.claude/settings.json` `env`, or a shell profile), for example
    `MDR_PROTECTED_SEGMENTS=approvals,legal/signed,legal/filed,registry`, and pick the name on comments with
    `MDR_USER_NAME=<name>`. Check with `mdr config get` (it prints the segments in effect and their source);
    `mdr config set protected "<same list>"` is the file-based equivalent.
  - **Port = `mdr port`, never computed in shell.** One server per served root, on the formula port or the next free
    one in its window of ten; `mdr open` adopts a running same-root server and never stops or takes over another
    root's. There is no `--force` and never a reason to want one. Concurrent reviews run in separate chats.
  - **The URL is `http://127.0.0.1:<port>/?file=<rel>`**, exactly as `mdr open` prints it. Point the in-app Browser
    pane at it (`preview_start` the first time, `navigate` after) and tell the user the URL you served on — "it's in
    the browser" is not a location. Never pass `mdr open --launch` here: it opens the system browser, which is only for
    sessions with no Browser pane.
  - **The waiter is `waiter.command` under Bash `run_in_background: true`, verbatim, and nothing else in the
    background while waiting.** End the turn with `wrap_up blocked:true`; the Send to Claude click wakes the session.
    Never a background Agent, Workflow or Monitor task while waiting (each shows the chat as "working"), never the
    waiter in the foreground, never a hand-written loop. `waiter: null` means Send copies a prompt to paste.
  - **Third-party documents are suggest-only:** `mdr open --suggest-only`; comments and suggestions, never direct
    edits or Edit/Write on the `.md`. Only the user lifts it.
  - **Not a clearance** — any formal sign-off runs before and after, unchanged. **Never serve a root containing a
    protected folder** such as `approvals/`, `legal/signed/`, `legal/filed/` or `registry/` (mdr refuses with
    `PROTECTED_ROOT` once the setup above is in place): the loop accepts writes to the file.
  - **`human-review` is the HTML tool only** — a running local web page or a standalone `.html`. Any `.md`, either
    direction, is `doc-review`. Never pick between them by which one ran last.
