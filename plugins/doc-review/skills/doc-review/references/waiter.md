# The waiter loop

How the user's **Send to Claude** click wakes a Claude Code session that ended its turn.

## What the loop line does

`mdr open` and `mdr arm` print `waiter.command`, one shell line built for this doc, this root and a fresh waiter id.
A generated line looks like this (example only; always use the one the CLI printed):

```
while :; do out=$("/Users/ana/.claude/plugins/data/doc-review-doc-review/node/bin/node" "/Users/ana/.claude/plugins/data/doc-review-doc-review/app/0.1.0-3f9a1c2d0e4b/mdr.mjs" wait "/abs/root/plan.md" --root "/abs/root" --waiter w_3f9a1c2d0e4b6a8c --timeout 3300); rc=$?; case $rc in 2) continue ;; 11) sleep 5; continue ;; esac; printf '%s\n' "$out"; exit $rc; done
```

- Each `wait` run holds one connection to the server for up to 55 minutes (3,300 s), with a heartbeat every 15 s and
  a 45 s watchdog that reconnects a silent socket after a laptop sleep or a network change.
- Exit 2 (timed out while connected): the loop re-runs it at once, silently. The server sees the gap as a brief
  re-arm and a click in it is latched for the next run.
- Exit 11 (the server stayed down until the deadline): the loop sleeps 5 s and re-runs it, until the server is back.
- Any other exit, 8 included, ends the loop: it prints exactly the last `wait` output (one JSON line) and exits with
  that code. That one line is what you read when the completion notification wakes you.
- When the user clicks Send, `wait` prints the handoff, consumes it, exits 0, and the loop exits: that exit is the wake.
- Clicks made while no loop is connected (during your turn, a re-arm gap, a server restart) are durable lines in the
  review log, delivered by the next loop on connect. Nothing is lost.

## Why only Bash `run_in_background`

The desktop app marks a session "working" for any background task that isn't a plain background Bash task. A
background Bash task leaves the sidebar on "needs input" and still re-invokes you when it exits. So:

- Start `waiter.command` with Bash `run_in_background: true`, verbatim: never edit it, wrap it, or write your own loop.
- Never under Monitor, and never inside a background Agent or Workflow: each shows the chat as "working".
- Never in the foreground in any form: a blocking tool call shows "working" for as long as it blocks, and there is
  no "stay on it" exception, because the loop already wakes you the moment the user clicks.
- Never run the CLI's wait any other way than through this line.

## Why nothing else may run in the background while you wait

`wrap_up blocked:true` puts the sidebar on "needs input" only if no background Agent, Workflow or Monitor task is
still running; any one of them flips it to "working" and the user reads that as "Claude is still busy". Before you end the
turn, stop such a task or let it finish. A background Bash task (the waiter) is the one exception, by design.

## One loop per session and doc

Start a loop after `mdr open`, and again at the end of a turn only when your previous loop has exited (it woke you,
or its completion notification arrived). `mdr arm` reports `attached` and `presence.waiterId`. If two copies run
anyway, the newer one supersedes the older, which exits 10 and wakes that session once; end that turn quietly.

## What each exit means when it wakes you

| Exit | Output | What to do |
|---|---|---|
| 0 | `{"ok":true,"status":"handoff","payload":{...},"prompt":"..."}` | The user sent the doc back: `mdr pending`, act, one `mdr batch` with the ack, end the turn with a new loop. |
| 10 | `WAITER_SUPERSEDED`, `DISARMED` or `SERVER_STOPPED` | Nothing is waiting on you; say so. Start a loop again only if the review is still open and `mdr arm` shows `attached: false`. |
| 8 | `PROTOCOL_MISMATCH` or `ROOT_MISMATCH` | Report it in one line. For `PROTOCOL_MISMATCH` tell the user to run `mdr serve "<root>" --restart`. `mdr arm` fails the same way, so start no new loop: Send falls back to the clipboard. |
| 9, 1, 130 | a `CliErr` | Report it in one line, run `mdr status`, end the turn as usual (a failing `mdr arm` means no new loop). |
| 2, 11 | never seen | The loop handles them itself. |

Delivery is at least once: if a `wait` died after printing but before consuming, the next loop could see the same
handoff. Your ack after acting consumes it, which is why every round's batch carries the ack.

## When there is no waiter

`waiter: null` means no loop can run here, and `waiterReason` says why: a clipboard-primary build, or Windows without a
POSIX shell (Git Bash), which the loop line needs. Send to Claude copies a ready prompt for the user to paste.
Start nothing; tell them "Send to Claude gives you a prompt to paste here." and end the turn. The same applies when
`mdr status --wait-waiter 5` doesn't show `connected`.
