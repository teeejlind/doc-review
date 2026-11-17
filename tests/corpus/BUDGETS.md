# Corpus budgets

Owner: P1 (CONTRACTS §0.2 S2-e and caveat 1, §3.4 G2/G7, §14 P1 item 10). The targets are the frozen S2-e numbers. `npm run corpus` measures every node row first (so the first parse is cold) and prints them under "budgets"; re-measure and update this file whenever `core/splice` changes.

Measured 2026-10-15 on the split API (M1), Node 26.5.0, Apple M5, `@milkdown/kit` 7.22.2, over the 91-file corpus (39 synthetic, 52 real; `python3 scripts/build-corpus.py`). Medians unless noted.

## Parse and save timings

| Measure | Where | Budget | Measured | Date | Notes |
|---|---|---|---|---|---|
| `load()` warm, 160 KB file | server (node/jsdom) | ≤ 100 ms | 76 ms (max 84) | 2026-10-15 | the largest real doc: 160,660 B, 25,171 words; classification cache warm |
| `load()` cold (first parse after boot), 160 KB file | server (node/jsdom) | ≤ 350 ms | 260 ms | 2026-10-15 | first `load()` in the process after `createMd()` (boot itself ~11 ms) |
| edit-save incl. verification | server (node/jsdom) | ≤ 100 ms | 71 ms (max 77) | 2026-10-15 | `planSave` + `applyBlockOps` (full re-classification of the result) for one-word edits in 5 distinct blocks of the 160 KB doc, each block uncached |
| `load()`, 10k-word perf fixture | browser (Chromium) | ≤ 250 ms | pending P2/P3 | | needs P3's `scripts/gen-perf-fixture.ts` and a real Chromium (§11.7); node/jsdom proxy on a deterministic 10,331-word doc: 26 ms cold-ish (after the 160 KB doc warmed the parser, not its blocks) |
| `updateLoaded` one-block op, 10k-word doc (G2) | node/jsdom | < 5 ms | 0.3 ms (max 1.0) | 2026-10-15 | deterministic 10,331-word synthetic doc, 25 runs; the real 10,678-word newsletter SKILL.md: 0.8 ms (max 1.7). Region re-parse only; hits the classification cache `applyBlockOps` verification filled |

S2-c (`fidelityHints`): kept. Node/jsdom, fresh boot per run (nothing cached), the real 10,678-word newsletter SKILL.md: `load()` 87 ms, `load(…, { fidelityHints })` 47 ms, median of 5. A 40 ms saving is above the 20 ms drop threshold; the Chromium measurement (P2/P3) confirms or overturns it by change request.

## Store writes (M2, informational; no frozen budget)

Whole `DocStore` calls on a synthetic 139,486-byte, 1,300-paragraph doc with 20 open comment threads, `openDocStore` in server mode, Node 26.5.0, Apple M5, APFS, measured while other worktrees ran their suites (the same session's corpus run showed `load()` warm at 164 ms against the 76 ms above, so treat these as upper bounds). Each includes the lock, reconcile (one read + sha256 of the disk), the splice with verification, the incremental `updateLoaded`, the re-resolution of every thread, the object write and three fsyncs (object, sidecar, doc tmp) plus the directory fsync.

| Measure | Measured | Date | Notes |
|---|---|---|---|
| `save()`, one-word edit, direct base | 122–141 ms (10 runs) | 2026-10-15 | dominated by `applyBlockOps` verification (the 71 ms row above); a full `load()` per save, before the store reloaded incrementally, put it at ~300 ms |
| `agent.batch` `replace_block` that also flushes a 10-save TJ session | 264 ms | 2026-10-15 | the flush, the `tj-session` and `claude-write` versions and the commit; ~1.2 s with full loads |

## Splice safety net (G7; expected 0 on the corpus)

| Counter | Corpus scope | Expected | Measured | Date |
|---|---|---|---|---|
| `widened` ops (any ladder level) | real + synthetic + sweep (4,812 edits) | 0 | 0 | 2026-10-15 |
| `failed` ops | real + synthetic + sweep (4,812 edits) | 0 | 0 | 2026-10-15 |
| list-merge flips, delete-block class (G0 flip column) | real corpus | 1 (S2) | 1 (plus 1 in the synthetic `syn__lists-adjacent.md`, which S2 did not have); each equals a same-marker adjacency the deletion created (G0-flip) | 2026-10-15 |

The ladder levels themselves are forced in `tests/unit/core/splice/ladder.test.ts` (a natural failure at each level, and each level forced by `setSpliceRenderHookForTests`).

## Corpus run

| What | Measured | Date |
|---|---|---|
| edits evaluated (S2 classes + 25-block sweep × 3 kinds) | 4,812 (S2: 4,137 over 73 files) | 2026-10-15 |
| full `tsx tests/corpus/run.ts` | 162–178 s | 2026-10-15 |
| block fidelity | paragraphs 2,081 exact / 320 semantic / 1 lossy; tables 1 exact / 181 semantic; 12 block-HTML entries promoted to raw `html` | 2026-10-15 |
