# Handoff — 2026-07-21 · Categories⇄Balance shipped end-to-end + backlog close-out

> Read this first. Everything the 2026-07-20 handoff planned is now **built, reviewed, and
> merged to main**. This doc is the closing record for that arc — start the next session
> from "What's next", not from re-deriving this history.

## TL;DR

- The full **Categories ⇄ Balance + textures** feature (Phases A–D) is merged. Migration
  head is **`0135_categories_capture`**.
- The independent UI backlog from 2026-07-20 (Jobs Run-all, Schedule Day bug, Focus
  FAB/header parity, day-scoped reminders) is merged.
- `feat/tasks-search` (pushed 2026-07-20, never opened) is merged.
- **One item is still outstanding**: `docs/ui-comments-round2` — pushed 2026-07-20, still
  never opened as a PR. It's a **spec/stub doc, not implementation** (see "What's next").
- Working tree is clean; no uncommitted changes anywhere in this arc.

---

## Merged this arc (session of 2026-07-21, chained off the 2026-07-20 handoff)

| PR | Base | What |
|---|---|---|
| **#413** | main | Schedule Day fix (was a misleading-success-toast bug, not an unwired button — the repoint also fixed `POST /api/auto/fill` silently ignoring `body.date`) · Jobs "Run all" · Focus FAB · "Plan my week" moved to Calendar |
| **#414** | main | Categories Phase B (capture): migration `0135` (category backfill + `texture_enabled`/`texture_color_token` on tasks + time_blocks), `entity_categories` write/read wiring, 1–3 picker on both wizard tabs, quick-add category classifier |
| #415 | feat/categories-capture | Categories Phase C (renderer): `elementTextureStyle` resolution rule, even category stripes, un-gated to every task/block, TaskCard shows categories not intentions — merged into #414's branch |
| #416 | feat/categories-capture | Categories Phase D (polish): Balance "N open" → related-tasks modal, functional Calendar category overlay (was inert) + palette toggle, Tags per-chip category selects — merged into #414's branch |
| **#417** | main | **Stacked-merge catch-up.** #414 had merged main from a snapshot of its base branch taken *before* #415/#416 landed on it — main was missing Phases C+D until this PR. No new code; delivered the already-reviewed delta. *(Second time this exact trap has bitten this repo — see "Gotcha" below.)* |
| **#418** | main | Focus header parity (Today-style card: Brief/Focus-goals/day-note) + day-scoped, restyled reminder picker |
| **#419** | main | `feat/tasks-search` rebased (was 16 commits behind) — always-visible Tasks search bar |
| **#420** | main | Docs-only: closed out `docs/HANDOFF-2026-07-20-categories-and-ui.md` with a PR-mapped status box; synced `README.md` + `ARCHITECTURE.md` (new §1.2) to migration head 0135 |

**Everything above is `state: MERGED` as of this doc.** Verified via `gh pr view` for each,
not assumed.

---

## What shipped, structurally

**Categories ⇄ Balance** (owner ruling 2026-07-20, decisions locked 2026-07-21):
- `tags.kind='category'` re-seeded to the six Balance dimensions
  (health/career/relationships/growth/leisure/finance), `is_base=1`. Add/remove stays behind
  `CATEGORIES_EDITABLE=false` (client/src/lib/flags.ts) — rename/recolour still allowed.
- New table `entity_categories(entity_kind, entity_id, category_tag_id, position)` — 1–3
  per task/block, `position` = stripe order. **Authoritative** for categories; the legacy
  `time_blocks.category_id` column is retired from the write path (bridged in, nulled on
  touch) but kept for back-compat reads.
- **The load-bearing relationship:** a block's effective categories are **its own rows, else
  its linked task's** (`blockCategoryNames`, `services/blocks.ts`). An auto-placed block
  needs no category write of its own — recategorizing the task re-derives everywhere
  (texture, Calendar overlay filter) for free.
- Renderer: `client/src/lib/textures.ts` `elementTextureStyle` — opt-out → colour override →
  even category stripes (`repeating-linear-gradient`, 1px/2px, interleaved in position
  order) → legacy motif fallback → none. Opacity halved (0.06→0.03), un-gated from
  routine-only to every task/block.
- Full detail + every owner decision: `docs/HANDOFF-2026-07-20-categories-and-ui.md`
  (now has a closed-out status box) and `ARCHITECTURE.md` §1.2.

**Independent fixes:** Schedule Day now does real intake (fill→run, honest toast); Jobs
"Run all" loops the existing per-job endpoint (no new server route — verified before
documenting it, see the gotcha in the previous session's notes); Focus matches Today's
header chrome; the reminder picker only offers today's tasks.

---

## Gotcha — the stacked-merge trap, twice now

When a PR's base is another feature branch (not main) and that base branch keeps
receiving merges (#415, #416 → `feat/categories-capture`) **after** an earlier PR (#414)
has already merged an earlier snapshot of it into main, main silently ends up missing the
later commits. This bit here (→ #417 catch-up) and previously bit `#209` (see
`docs/S-schema-consolidation.md` per repo memory). **Before treating main as "done" after
a stacked-PR sequence, always diff:** `git log origin/main..origin/<feature-branch>` — a
non-empty result means main is behind, regardless of what GitHub's PR list says is merged.

---

## What's next

1. **`docs/ui-comments-round2`** (pushed 2026-07-20, still unopened) — a **spec/stub doc**,
   not implementation: Today/Planner layout items 6–11 (move `DayStarsRow`, DUE
   card→header+modal, `DayTypeControl` into the Planner header, etc.). **Item 6 ("remove
   the direction-window hatch") is superseded** — Phase C kept and enhanced textures
   instead of removing them. Items 7–11 are still open UI backlog, never built. Read the
   stub, confirm scope against the current UI (some of it may already be stale after this
   session's Focus/Calendar changes), then decide whether to build it or retire the branch.
2. **Local branch cleanup** (optional) — this worktree has ~13 local branches from this and
   prior sessions now fully merged into main (`feat/categories-*`, `feat/focus-*`,
   `feat/tasks-search`, several `docs/handoff-*`). Safe to delete once confirmed merged;
   left alone for now since deleting branches wasn't asked for.
3. Nothing else from the 2026-07-20 handoff is outstanding.

---

## Repo facts worth carrying

- **Migration head `0135_categories_capture`; next slot `0136`.**
- **`CATEGORIES_EDITABLE=false`** (`client/src/lib/flags.ts`) — still the locked state;
  flip once Balance-dimension editing is designed.
- **`entity_categories`** is authoritative for categories; `time_blocks.category_id` is
  read-only back-compat, never written.
- Full server suite passed 2143, client 636 at last full run this arc (individual PRs
  re-verified after each rebase/merge).
