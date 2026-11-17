# `mdr batch`: ops, the base map, recoveries

One `mdr batch "<abs>"` per round, with a `BatchRequest` on stdin (or `--ops-file F`):

```sh
mdr batch "/abs/root/plan.md" <<'JSON'
{"ops":[ ... ], "ack": 118, "ackSince": 97}
JSON
```

- **All or nothing.** Ops apply in array order against an in-memory copy; then one write. Any failure rejects the
  whole batch with `error.op` = the failing op's index, and nothing is written.
- **The ack goes last**, in the same request: `"ack": <pending.cursor>, "ackSince": <pending.since>`. If another
  session acked first you get `ACK_CONFLICT`: run `mdr pending` again. Sending your own identical batch again (you
  never saw the answer) is not a conflict: it answers `duplicate: true` per op, with the same `acked` and `consumed`.
- **Keys.** Leave `key` out; the store derives one from the round, so retrying the same batch in the same round
  answers `duplicate: true` with the original ids. Set `key` only to make two identical ops distinct on purpose.
- `"dryRun": true` (or `--dry-run`) validates and reports without writing.

## One example per op

Comment on a quote (source text, byte-exact; `occurrence` or `near` when it appears more than once):

```json
{"op":"comment","quote":"member rate of 12%","body":"Is 12% still current?"}
```

```json
{"op":"comment","quote":"member rate","occurrence":2,"body":"This one too?"}
```

```json
{"op":"comment","quote":"member rate","near":{"ref":"b7","rev":42},"body":"Disambiguated by block."}
```

Comment on the whole doc, or on a block (frontmatter, an hr, an HTML block: anything a quote can't anchor):

```json
{"op":"comment","doc":true,"body":"Overall: the intro runs long."}
```

```json
{"op":"comment","block":{"ref":"b1","rev":42},"body":"The status header is out of date."}
```

Reply on a thread:

```json
{"op":"reply","thread":"t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7","body":"Yes, 12% is current as of the 10/1 deal brief."}
```

Suggest a change the user accepts or rejects on its own (one op per independent change):

```json
{"op":"suggest","quote":"utilize","replace":"use","reason":"House style: plain words."}
```

Suggest a deliberate whole-block rewrite (one decision for the whole block):

```json
{"op":"suggest_block","target":{"ref":"b9","rev":42},"markdown":"We launch in Q4 2026, after the pilot.","reason":"Tighter."}
```

Direct edits (never on a suggest-only doc):

```json
{"op":"replace_block","target":{"ref":"b3","rev":42},"markdown":"We launch in Q4 2026."}
```

```json
{"op":"replace_range","from":{"ref":"b3","rev":42},"to":{"ref":"b5","rev":42},"markdown":"One paragraph instead of three."}
```

```json
{"op":"insert_after","target":{"quote":"We launch in Q4."},"markdown":"A new paragraph after it."}
```

```json
{"op":"insert_before","target":{"line":30,"rev":42},"markdown":"## A new heading"}
```

```json
{"op":"delete_block","target":{"ref":"b11","rev":42}}
```

```json
{"op":"write","markdown":"# Launch plan\n\nThe whole new document.\n","baseRev":42}
```

`write` replaces the whole doc but writes only the blocks that changed; it must be the batch's only byte change.

Threads, your own messages and suggestions, and the user's suggestions:

Resolve silently (no `body`) when you carried out what the thread asked: the edit is the answer. A `body` is a
closing message the user reads; only send one when they must check something (SKILL.md, "When to reply").

```json
{"op":"resolve","thread":"t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7"}
```

```json
{"op":"reopen","thread":"t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7"}
```

```json
{"op":"edit_comment","comment":"c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8","body":"Corrected figure: 12%."}
```

```json
{"op":"delete_comment","comment":"c_01JAB3K9Q2T7V5X8Y0Z1W2E3R8"}
```

```json
{"op":"withdraw","suggestion":"s_01JAC3K9Q2T7V5X8Y0Z1W2E3R9"}
```

```json
{"op":"decide","suggestion":"s_01JAD3K9Q2T7V5X8Y0Z1W2E3R9","decision":"reject"}
```

`decide` works only on the user's suggestions; `accept` is a direct edit (refused on suggest-only docs).

## A whole round

```json
{"ack":118,"ackSince":97,"ops":[
 {"op":"reply","thread":"t_01JAB3K9Q2T7V5X8Y0Z1W2E3R7","body":"Yes, 12% is current as of the 10/1 deal brief."},
 {"op":"replace_block","target":{"quote":"We launch in Q4."},"markdown":"We launch in Q4 2026."},
 {"op":"resolve","thread":"t_01JAE3K9Q2T7V5X8Y0Z1W2E3R7"},
 {"op":"suggest","quote":"utilize","replace":"use","reason":"House style: plain words."}]}
```

The question gets an answer; the instruction ("add the year") was carried out and resolved without a reply.

## Refs come from one snapshot: the base map

Every positional selector (`{"ref","rev"}`, `{"line","rev"}`, `near`) in one batch carries the same rev, the current
one, and names a block of the map **at that rev, before op 0**. Copy refs straight from one `mdr snapshot`; never
shift them for earlier ops in the same batch. Quote selectors instead see the text as edited by the earlier ops.

Base rev 42; the snapshot shows `b3` = "We launch in Q3.", `b4` = a heading, `b9` = a paragraph:

```json
{"ops":[
 {"op":"insert_after","target":{"ref":"b3","rev":42},"markdown":"A new paragraph after b3."},
 {"op":"replace_block","target":{"ref":"b9","rev":42},"markdown":"Rewritten b9."},
 {"op":"delete_block","target":{"ref":"b4","rev":42}}]}
```

`b9` and `b4` still mean the base `b9` and `b4`, although op 0 inserted a block before them. A second
`replace_block` on `b9` in the same batch fails `BATCH_SELF_CONFLICT` at that op: fold both changes into one op.
The same holds for suggestions: one `suggest` or `suggest_block` per block per batch, and a `comment` after a
`suggest` or edit on that block conflicts too (a comment before it is fine). Further changes to that block go in their own
`mdr suggest` or batch after the first has landed.

## Common recoveries

`STALE_REVISION` (exit 7): the user saved since your snapshot. `remap` maps your old refs to current ones for blocks that
didn't change, and `current` carries the fresh snapshot. Retry with the remapped refs and `current.rev`, or switch to
a quote selector. A block the user changed has no `remap` entry (the hint then says "nothing to remap"): take its ref from a
fresh `mdr snapshot --md`.

```json
{"ok":false,"error":{"code":"STALE_REVISION","message":"b7 was read at rev 40; the doc is at rev 42 (the user saved twice).","hint":"retry with the remapped ref and rev 42, or use a quote selector","remap":{"b7":"b8"}}}
```

`BATCH_SELF_CONFLICT` (exit 7): two ops in one batch hit the same block. `error.op` is the second one,
`error.details` names the block and the earlier op. Nothing was written; merge the ops or send the second one on its
own (a batch after the first has landed).

```json
{"ok":false,"error":{"code":"BATCH_SELF_CONFLICT","message":"op 1: base block b2 was already changed or suggested on by op 0 in this batch","hint":"one batch can change or suggest on a block only once: merge the ops on this block into one (for suggestions, one suggest whose quote covers both changes), or send this op as its own command or batch after op 0 has landed","op":1,"details":{"block":"b2","earlierOp":0}}}
```

`QUOTE_AMBIGUOUS` (exit 6): the quote matches more than once. Pick the right one from `candidates` and retry with
`"occurrence": N` (`--occurrence N`) or `"near": {"ref": "bN", "rev": R}` (`--near bN --base-rev R`).

```json
{"ok":false,"error":{"code":"QUOTE_AMBIGUOUS","message":"quote matches 2 places","hint":"pass --occurrence N, or --near bN --base-rev R","op":0,"candidates":[{"occurrence":1,"block":"b7","line":23,"context":"the notes carry a ⟦member rate⟧ of 12%"},{"occurrence":2,"block":"b19","line":71,"context":"a fixed ⟦member rate⟧ is paid"}]}}
```

`QUOTE_NOT_IN_SOURCE` (exit 5): you quoted rendered text (no `**`, link syntax or escapes). Retry with the exact
source span the server found, `error.sourceQuote`.

```json
{"ok":false,"error":{"code":"QUOTE_NOT_IN_SOURCE","message":"the quote matches rendered text only","op":2,"sourceQuote":"**member rate** of 12%"}}
```

`SUGGEST_ONLY` (exit 4): the doc is suggest-only and the batch had a direct edit. Nothing was written. Turn the edit
into a `suggest` (quote → replacement) or `suggest_block`, and send the batch again.

```json
{"ok":false,"error":{"code":"SUGGEST_ONLY","message":"this doc is suggest-only","hint":"this doc is suggest-only: use suggest","op":3}}
```
