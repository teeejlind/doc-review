# mdr command reference

Every command prints exactly one JSON document on stdout (`--pretty` indents it) and exits with a code from the
table at the end. `<file>` is absolute or relative to the cwd; global flags on every command: `--root <dir>`,
`--pretty`, `--verbose` (progress on stderr). Long text never goes through shell quoting: `--body -`,
`--replace -` and `--md -` read stdin; `--body-file F`, `--replace-file F`, `--md-file F` and `--ops-file F` read
files.

Server up → the command talks to it over HTTP. Server down → reads and writes go direct to the files under the doc
lock (`via: "direct"`), and a server started later adopts those writes as yours. Only `serve`, `open` and `arm`
start a server; `wait` never does.

`mdr --version` prints `{"ok":true,"version":"…"}`. When `MDR_CMD` is set (a plugin install that runs mdr another
way), every hint and prompt the CLI prints names that command instead of `mdr`; run them as printed.

The stored actor id for the user in every result is `TJ`, whatever their name: `by` on their messages and
suggestions, `decidedBy`, and `by` with `cause: "tj-session"` in `history`. It means the person in `user.displayName`
(`open`, `status`, `pending`); never call them `TJ`. Your writes read `Claude`, other tools' writes read `external`.

Every single-op write command is sugar for `batch` with one op (`ack` is `ops: []` plus `ack`), so its result is
always a `BatchResult`. The CLI never invents an idempotency key: pass `--key K` to choose one, otherwise the store
derives it from the round, so a retried command in the same round answers `duplicate: true`.

## Commands

| Command | Example | Result |
|---|---|---|
| port | `mdr port "/abs/root"` | `PortResult` (formulaPort, port, state up / free / exhausted) |
| serve | `mdr serve "/abs/root"` | `ServeResult` (adopted, or restarted with `--restart`; `--foreground` and `--port N` are for tests and dev) |
| stop | `mdr stop "/abs/root"` | `StopResult` (same root only; `stopped: false` when none is running). `mdr stop --all` stops every mdr server on the port windows: `StopAllResult` (stopped, failed) |
| open | `mdr open "/abs/root/plan.md" --suggest-only` | `OpenResult` (url, rev, waiter spec or null with `waiterReason`, presence, policy, `user`) |
| open (no Browser pane) | `mdr open "/abs/root/plan.md" --launch` | `OpenResult` plus `launched`: the system browser opened, only when no tab could take the doc (none connected, or only tabs on other docs: `open` never navigates those) |
| open (first review) | `mdr open "/abs/root/plan.md" --offer-tour` | `TourOfferResult` (`tour: "offer"`, `opened: false`) when the tour was never offered on this computer, else `OpenResult`. `--skip-tour` records a declined tour and opens
| arm | `mdr arm "/abs/root/plan.md"` | `ArmResult` (fresh waiter spec, attached, presence, server, policy) |
| status | `mdr status "/abs/root/plan.md" --wait-waiter 5` | `StatusResult` |
| snapshot | `mdr snapshot "/abs/root/plan.md" --md --from b3 --to b9` | `AgentSnapshot` (refs bN + rev; `--md` adds markdown) |
| pending | `mdr pending "/abs/root/plan.md"` | `PendingResult` (never acks) |
| thread | `mdr thread "/abs/root/plan.md" t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7` | `ThreadDetail` |
| comment | `mdr comment "/abs/root/plan.md" --quote "opens on April 12" --body "Still the date?"` | `BatchResult` |
| comment (block) | `mdr comment "/abs/root/plan.md" --block b4 --base-rev 42 --body -` | `BatchResult` |
| comment (doc) | `mdr comment "/abs/root/plan.md" --doc --body-file /tmp/notes.txt` | `BatchResult` |
| reply | `mdr reply "/abs/root/plan.md" t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7 --body "Yes, per the 10/1 planning notes."` | `BatchResult` |
| suggest | `mdr suggest "/abs/root/plan.md" --quote "utilize" --replace "use" --reason "House style: plain words."` | `BatchResult` (suggestion, anchor, hunks) |
| suggest (block) | `mdr suggest "/abs/root/plan.md" --block b7 --base-rev 42 --md -` | `BatchResult` |
| edit-block | `mdr edit-block "/abs/root/plan.md" --ref b3 --base-rev 42 --md "We launch in Q4 2026."` | `BatchResult` |
| edit-block (insert) | `mdr edit-block "/abs/root/plan.md" --quote "We launch in Q4." --insert-after --md-file /tmp/para.md` | `BatchResult` |
| edit-block (delete) | `mdr edit-block "/abs/root/plan.md" --line 30 --base-rev 42 --delete` | `BatchResult` |
| edit-block (range) | `mdr edit-block "/abs/root/plan.md" --from b3 --to b5 --base-rev 42 --md -` | `BatchResult` (`--from` / `--to` take bN, line:N or quote:TEXT) |
| write | `mdr write "/abs/root/plan.md" --base-rev 42 --md-file /tmp/plan.md` | `BatchResult` (only changed blocks are written) |
| resolve | `mdr resolve "/abs/root/plan.md" t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7` | `BatchResult`. Silent by default; `--body` adds a closing message only when the user must check something |
| reopen | `mdr reopen "/abs/root/plan.md" t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7` | `BatchResult` |
| decide | `mdr decide "/abs/root/plan.md" s_01JAC3K9Q2T7V5X8Y0Z1W2E3R9 reject` | `BatchResult` (the user's suggestions only) |
| withdraw | `mdr withdraw "/abs/root/plan.md" s_01JAC3K9Q2T7V5X8Y0Z1W2E3R9` | `BatchResult` (your own only) |
| edit-comment | `mdr edit-comment "/abs/root/plan.md" c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8 --body "Corrected."` | `BatchResult` (your own only) |
| delete-comment | `mdr delete-comment "/abs/root/plan.md" c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8` | `BatchResult` (your own only) |
| ack | `mdr ack "/abs/root/plan.md" --cursor 118 --since 97` | `BatchResult` (compare-and-swap on `--since`) |
| batch | `mdr batch "/abs/root/plan.md" --ops-file /tmp/round.json` | `BatchResult` (`--dry-run` writes nothing) |
| wait | `mdr wait "/abs/root/plan.md" --root "/abs/root" --waiter w_0123456789abcdef --timeout 3300` | `WaitResult`. Never run this yourself: it runs only inside `waiter.command` |
| disarm | `mdr disarm "/abs/root/plan.md"` | `DisarmResult` (end of review; the live waiter exits 10) |
| history | `mdr history "/abs/root/plan.md" --diff v3..current` | `HistoryList` / `VersionShow` (`--show vN`) / `HistoryDiff` (read-only; restore is the user's) |
| doctor | `mdr doctor "/abs/root/plan.md"` | `DoctorResult` (`--repair`, `--compact`, `--gc` only on the user's say-so) |
| config | `mdr config set name "Ana Díaz"` | `ConfigResult` (path, config, `user`, protected segments in effect). `mdr config get`; `mdr config set protected "approvals,registry"`; `mdr config unset name`; `mdr config set tour done` / `unset tour` (`tour`: offer or done) |
| import-gdoc | `mdr import-gdoc "/abs/root/feedback.md" --gdoc-json "/abs/scratch/read_doc.json"` | `ImportGdocResult` (counts, notes, items with `landed` text or doc and `why`). Refuses an existing file or review |
| export-gdoc | `mdr export-gdoc "/abs/root/plan.md"` | `ExportGdocPrepared` (step `upload`: uploadPath, sha256, `fileRef` for Drive `create_file`). Then `--gdoc-json F` → `ExportGdocComments` (insertComment `requests`, `placed`); then `--comment-ids a,b` → `ExportGdocReplies` |
| export-docx | `mdr export-docx "/abs/root/plan.md" --out "/abs/root/plan-review.docx"` | `ExportDocxResult` (out, comments, replies, general). `--overwrite` replaces an existing file |
| tour | `mdr tour` | `TourResult`: `OpenResult` plus `tour` (folder, cards). Copies the practice doc into `Documents/doc-review tutorial/` (a fresh `... 2.md` if one was used), posts six cards as Claude, opens it, records the tour. `--dir F` picks another folder (never the home folder itself) |

Selectors: positional ones (`--ref bN`, `--line L`, `--near bN`, `--block bN`) need `--base-rev R` and fail
`STALE_REVISION` with a `remap` when the doc moved; quote ones (`--quote Q`, `--occurrence N`) match the markdown
source and need no rev.

## Exit codes

`0` ok (including `duplicate` and `noop` results). `2` the waiter's `wait` timed out while connected: the loop re-runs
it. `11` `wait` gave up on a server that stayed down: the loop sleeps 5 s and re-runs it. Every other code is an error
and the JSON is a `CliErr` (`{ ok: false, error: { code, message, hint?, ... } }`).

| Code | Exit | HTTP | What to do |
|---|---|---|---|
| `BAD_REQUEST` | 3 | 400 | Fix the command or the JSON (the message names the field); retry. |
| `USAGE` | 3 | - | Fix the flags (see the command table above); retry. |
| `IDENTITY_IN_BODY` | 3 | 400 | Remove `by` / `author` / `actor` from the body: identity comes from the route. |
| `PAYLOAD_TOO_LARGE` | 3 | 413 | Split the batch, or send long text with `--md-file` / `--body-file`. |
| `ACK_OUT_OF_RANGE` | 3 | 400 | Ack only a `cursor` that `mdr pending` returned. |
| `UNAUTHORIZED` | 4 | 401 | The token in `.review/server.json` is wrong or missing: tell the user; `mdr serve "<root>" --restart` re-reads it. |
| `FORBIDDEN_ORIGIN` | 4 | 403 | Never send an Origin on agent calls; use the CLI, not a browser fetch. |
| `PROTECTED_ROOT` | 4 | 403 | The root is `/` or `$HOME`, or the root or file is (or holds) a folder the user marked protected (`MDR_PROTECTED_SEGMENTS` / `mdr config set protected`). Serve a narrower folder; never work around it. |
| `PATH_OUTSIDE_ROOT` | 4 | 403 | The file is outside the served root (or a symlink escapes it): pass the right file or `--root`. |
| `NOT_AUTHOR` | 4 | 403 | You can edit, delete or withdraw only your own items, and decide only the user's suggestions. |
| `SUGGEST_ONLY` | 4 | 403 | This doc is suggest-only: use `suggest` / `suggest_block` / comments. Lift it only with `--allow-edits` after the user says so. |
| `READ_ONLY` | 4 | 422 | The doc is read-only (see `readOnly` in `mdr status`): report it; nothing can be written. |
| `UNANCHORABLE_TARGET` | 4 | 422 | Frontmatter, an hr or a raw/HTML block: comment with `--block bN --base-rev R`, or change it with `edit-block`. |
| `FILE_NOT_FOUND` | 5 | 404 | Check the path; the doc may have been moved or deleted. |
| `DOC_GONE` | 5 | 410 | The doc was deleted or renamed while open: tell the user; nothing more to do on it. |
| `THREAD_NOT_FOUND` | 5 | 404 | Re-read with `mdr pending` / `mdr snapshot` and use a current thread id. |
| `COMMENT_NOT_FOUND` | 5 | 404 | Re-read with `mdr thread` and use a current comment id. |
| `SUGGESTION_NOT_FOUND` | 5 | 404 | Re-read with `mdr thread` / `mdr snapshot` and use a current suggestion id. |
| `VERSION_NOT_FOUND` | 5 | 404 | List versions with `mdr history` first. |
| `BLOCK_NOT_FOUND` | 5 | 404 | Take refs from a fresh `mdr snapshot`. |
| `QUOTE_NOT_FOUND` | 5 | 422 | The quote isn't in the source: copy it byte-exact from `mdr snapshot --md` (near-misses are listed). |
| `QUOTE_NOT_IN_SOURCE` | 5 | 422 | The text is rendered, not source: retry with `error.sourceQuote`. |
| `QUOTE_IN_PENDING_SUGGESTION` | 5 | 422 | The text exists only inside a pending suggestion: reply on that suggestion's thread instead. |
| `QUOTE_AMBIGUOUS` | 6 | 422 | Pass `--occurrence N` (from `candidates`) or `--near bN --base-rev R`. |
| `STALE_REVISION` | 7 | 409 | The doc moved: use `error.remap` and the `current` snapshot's rev, or a quote selector; retry. |
| `CONFLICT` | 7 | 409 | Re-read (`current` is attached) and retry against the new text. |
| `SUGGESTION_OVERLAP` | 7 | 409 | Another pending suggestion covers that span: reply on its thread (`error.thread`) or wait for the user's decision. |
| `SUGGESTION_CLOSED` | 7 | 409 | Already decided or withdrawn: re-read the thread; nothing to retry. |
| `SUGGESTION_STALE` | 7 | 409 | Its base text is gone: withdraw it and suggest again against the current text. |
| `SUGGESTION_CHANGED_SINCE` | 7 | 409 | The accepted text changed since: re-read; do not force the undo. |
| `BLOCK_MERGE_HAZARD` | 7 | 422 | The edit would merge with a neighbour (e.g. two adjacent lists): change the markdown or the target. |
| `BATCH_SELF_CONFLICT` | 7 | 422 | Two ops in one batch hit the same base block (`error.op`, `error.details.earlierOp`): merge them into one op, or send the second as its own command or batch. |
| `ACK_CONFLICT` | 7 | 409 | Another session acked first: run `mdr pending` again and ack its cursor with its `since`. (Your own identical batch sent twice is not this: it answers `duplicate: true`.) |
| `SERVER_START_FAILED` | 8 | - | The server did not start (log lines in `details`): report it in one line. |
| `SERVER_UNREACHABLE` | 11 | - | `wait` only: the waiter loop sleeps 5 s and re-runs it by itself. Nothing to do. |
| `ROOT_MISMATCH` | 8 | - | Another server answered for this port: report it; do not retry the loop. |
| `PORT_EXHAUSTED` | 8 | - | All ten ports in the root's window are taken by other roots or processes: tell the user; `mdr port` shows the window. |
| `PROTOCOL_MISMATCH` | 8 | 426 | An old server: tell the user to run `mdr serve "<root>" --restart`; start no loop until `mdr arm` succeeds. |
| `MISDIRECTED` | 8 | 421 | Wrong Host: use the CLI as printed by `mdr open`. |
| `LOCK_TIMEOUT` | 9 | 503 | Another writer holds the doc lock: retry once; report if it persists. |
| `SIDECAR_CORRUPT` | 9 | 500 | The review log is corrupt (read-only): tell the user; `mdr doctor` reports it, `--repair` only on their say-so. |
| `SIDECAR_SCHEMA_UNSUPPORTED` | 9 | 500 | The review log is from a newer mdr (read-only): tell the user to update the CLI. |
| `NOT_UTF8` | 9 | 415 | The doc is not UTF-8 (read-only): report it. |
| `TOO_LARGE` | 9 | 413 | The doc is over 5 MiB (read-only): report it. |
| `SUGGESTION_RESIDUE` | 9 | 500 | Report it in one line; the save was refused and nothing changed. |
| `SPLICE_MISMATCH` | 9 | 500 | Report it in one line; nothing was written. Re-read and retry once. |
| `CONTRACT_MISMATCH` | 9 | 409 | A stale UI bundle: the user reloads the page. |
| `IO_ERROR` | 9 | 500 | A disk error: report it in one line. |
| `WAITER_SUPERSEDED` | 10 | - | Another waiter took over: nothing is waiting on you; start a loop only if `mdr arm` shows `attached: false`. |
| `SERVER_STOPPED` | 10 | - | The server was stopped: nothing is waiting; say so. |
| `DISARMED` | 10 | - | The review was ended with `mdr disarm`: say nothing more. |
| `INTERNAL` | 1 | 500 | Report it in one line and run `mdr status`. |
| `INTERRUPTED` | 130 | - | The process was interrupted; nothing to do. |
