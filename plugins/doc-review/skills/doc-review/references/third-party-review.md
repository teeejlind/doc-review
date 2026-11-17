# Third-party documents: suggest-only

A document someone else wrote (an agency, a vendor, an outside author, a colleague's draft the user was asked to
review) is reviewed, never rewritten in place, because the user has to see what changed and why.

## Who decides

Treat a doc as third-party when the user hands it over to "review", "mark up", "comment on", "redline" or "give notes on"
and it isn't the user's own draft or one you produced for them. When unsure, ask them in one line before opening it.

## What you may do

- `comment` on a quote, a block or the whole doc
- `reply`
- `suggest` (quote → replacement) and `suggest_block` (a whole-block rewrite)
- `resolve` (silently, once nothing is left for the user to decide) and `reopen`
- `withdraw` your own suggestions
- `decide` with `reject`
- the ack

## What you never do

- `replace_block`, `replace_range`, `insert_after` / `insert_before`, `delete_block`, `write`
- `decide` with `accept`
- the Edit or Write tools on the `.md`

## How it is enforced

`mdr open "<abs>" --suggest-only` records `policy.set { suggestOnly: true }` in the review log before it prints the
waiter spec. From then on every batch containing a direct edit fails `403 SUGGEST_ONLY` (exit 4) with the hint
"this doc is suggest-only: use suggest", and nothing in that batch is written. The policy lives in the review log,
so it holds across turns, sessions and server restarts.

Only the user lifts it: the rail-header toggle "Claude may edit directly", or `mdr open "<abs>" --allow-edits` /
`mdr arm "<abs>" --allow-edits` after they say so in chat. `mdr status`, `mdr open` and `mdr arm` report the current
value in `policy.suggestOnly`. The user's own editing in the browser is never restricted.

## The deliverable

A summary of the review in chat: counts by type (comments, suggestions) and the 3–5 most important suggestions, each
in a line. Never a rewritten copy of the document, in chat or on disk.

## Worked example

The user: "Give me notes on the agency's press release." It's the agency's draft, so:

```sh
mdr open "/abs/root/press/agency-release.md" --suggest-only
mdr snapshot "/abs/root/press/agency-release.md" --md
```

Then one batch with comments and suggestions only:

```json
{"ops":[
 {"op":"comment","doc":true,"body":"Overall: strong lede; the second half repeats the first. Notes below."},
 {"op":"suggest","quote":"the best platform on the market","replace":"a platform built for teams like yours","reason":"Superlatives need proof; keep it factual."},
 {"op":"suggest","quote":"guaranteed results","replace":"results our customers have seen","reason":"Don't promise an outcome."},
 {"op":"comment","quote":"over 10,000 customers","body":"Which figure and as-of date? This needs a source before it ships."},
 {"op":"suggest_block","target":{"ref":"b9","rev":3},"markdown":"We build project tools for small teams.","reason":"The boilerplate drifted from the approved version."}]}
```

Then the chat summary: "3 suggestions, 2 comments on the agency release. Most important: the guarantee language in
para 4, the unsourced customer count in para 6, and the boilerplate." Start the waiter loop and end the turn as usual.
