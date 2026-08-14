> **Type:** Test · **Phase:** LLM streamline (2026-08-14) · **Branch:** `test/suggesttags-casing` · **Commit style:** `test(llm): pin suggestTags' case-insensitive vocabulary match` · **Design:** this ticket is the spec · **Dependencies:** llm-4 (merged, #525). Independent of llm-3 (#529) and llm-7 (#530).

> **STATUS: READY. Verified against `main` @ `a0f0b2e` on 2026-08-14 by reading each cited file.**

## Goal

llm-4 (#525) changed `suggestTags`' vocabulary match from **case-sensitive exact** to
**case-insensitive with canonical casing**, and the owner accepted it as a latent bug fix: a model
answering `"finance"` when the vocabulary says `"Finance"` used to be silently dropped and is now
kept, correctly cased.

**That behaviour has no test.** `server/src/agents/tags.ts` has no test file at all — there is no
`tags-suggest.test.ts`, and none of `tag-directions` / `tag-parity` / `tag-prefs-*` / `tags-owner` /
`tag-tasks-job` / `constrain` exercises `suggestTags` directly. So an accepted, deliberate
behaviour change on a **write path** rests on nothing, and a future edit could silently revert it.

This ticket adds the missing coverage. **It is test-only — no source change.**

## Why it matters that this is a write path

`suggestTags` has two callers:
- `routes/tasks.ts:391` — the New Task wizard, suggest-only.
- `services/auto-tag.ts:142` — `tagUntaggedTasks`, which **writes** `entity_tags` rows. It backs
  both the Tasks view's Auto-tag button and the `tag_tasks` cron.

So "more tags survive the allow-list" means "more tags get written automatically". The safety net
is that `mergeTags` (`services/auto-tag.ts:34`) re-filters case-**sensitively** against the same
`names` list, and canonical names are members of it by construction — that invariant is worth
pinning too, because it is what makes the accepted change safe.

## Non-goals

- **Do not change `server/src/agents/tags.ts`.** ⚠️ PR #529 (llm-3) is converting that file's
  `catch { return [] }` into `llmOrNull`. Touching the source would collide. This ticket adds a test
  file and nothing else.
- Do not change `constrainToVocabulary` or `agents/constrain.ts` — the shared rule is correct; this
  pins how `suggestTags` consumes it.
- Do not test the Ollama-down degrade path here — that is #529's territory and it has its own
  coverage in `llm-degrade.test.ts`.
- Do not add an integration test that hits a live model. Stub the `generateJson` seam.

## Pinned conventions

- New file `server/test/tags-suggest.test.ts`.
- Stub the model seam with `vi.mock('../src/mcp/ollama.js', …)` returning a canned
  `{ tags: [...] }`, the pattern `server/test/render-copy.test.ts` and
  `server/test/memory-suggest.test.ts` already use. Do NOT hit a live Ollama — the suite must stay
  offline and deterministic.
- Assert on `suggestTags`' return value, not on `constrainToVocabulary` directly (that already has
  `constrain.test.ts`); the point is to pin the composition at this call site.
- Comment each case with WHY it exists, matching the repo's constraint-stating style — in particular
  that the casing case is a deliberate 2026-08-14 decision, not incidental.

## Cases

- [ ] A model answer whose casing differs from the vocabulary (`"finance"` vs `"Finance"`) is
      **kept**, and returned in the **vocabulary's** casing. This is the accepted behaviour change;
      before #525 it was dropped.
- [ ] An invented name not in the vocabulary is **dropped** (the never-invent rule).
- [ ] Repeated names differing only by case collapse to **one** entry.
- [ ] Leading/trailing whitespace in the model's answer is tolerated.
- [ ] A non-array / non-string answer yields `[]` rather than throwing.
- [ ] An empty title or empty vocabulary short-circuits to `[]` **without calling the model**
      (assert the stub was not invoked — this is the existing guard at `tags.ts:26`).
- [ ] The `directions` grounding only appears in the prompt when the offered vocabulary actually
      contains those direction names (the `pickable` guard at `tags.ts:30`).
- [ ] **The downstream invariant**: a canonical name returned by `suggestTags` survives
      `mergeTags(llm, heuristic, names)` — i.e. the case-insensitive match cannot produce a name the
      case-sensitive downstream filter would then throw away. This is the assertion that makes the
      accepted change provably safe.

## Files impacted

**New:** `server/test/tags-suggest.test.ts`
**Changed:** none. If you find yourself editing a source file, stop and report.

## Schema required

None.

## Definition of Done

- [ ] `server/test/tags-suggest.test.ts` exists and covers every case above.
- [ ] `git diff --stat` shows **exactly one file**, and it is the new test.
- [ ] The suite runs offline — no live Ollama call, deterministic under repeat runs.

## Tests

```
pnpm --filter server typecheck
pnpm --filter server vitest run test/tags-suggest.test.ts test/tag-tasks-job.test.ts test/constrain.test.ts
pnpm --filter server test
```

**Five test failures are pre-existing and Windows-only** — `test/restore.test.ts` (5) and
`test/cli-scripts-env.test.ts` (collection error at `new URL(import.meta.url).pathname` →
`C:\C:\...`). Confirm against a clean checkout before attributing any failure to this change.

## Acceptance Criteria

- [ ] Given a model answers `"finance"` and the vocabulary holds `"Finance"`, then `suggestTags`
      returns `["Finance"]` — and a reviewer reading the test learns this was a deliberate decision.
- [ ] Given someone later reverts the shared rule to a case-sensitive match, then this test fails.

## Subtasks

1. [ ] Read `server/src/agents/tags.ts`, `server/src/agents/constrain.ts`, and the mock style in
       `server/test/memory-suggest.test.ts`.
2. [ ] Write the test file with the stubbed seam.
3. [ ] Add the `mergeTags` downstream-invariant case.
4. [ ] Confirm the diff is exactly one new file.
