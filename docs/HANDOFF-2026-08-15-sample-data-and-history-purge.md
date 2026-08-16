# Handoff — CI-Planning: sample data is generic, history is purged, screenshots are not

For whoever picks this up — human or agent. Everything here is verifiable from the
repo; nothing depends on the session that wrote it.

## Where things stand

The dev database is unlinked from the app (personal DB backed up privately, local
dev points at a throwaway path), the FTUE sample-data path no longer ingests real
fixture content, every fixture and doc that carried real names/companies/emails is
synthetic, and **git history itself has been rewritten and force-pushed** to remove
that content retroactively — not just at HEAD.

Main is at `51ee7028`. Measured, not assumed: server **3166 passing** / 242 files,
client **1057 passing** / 81 files, `tsc` clean on both — verified twice: once
against the live tree, once again directly against the rewritten history's checkout
before anything was pushed.

| Item | State | PR |
| --- | --- | --- |
| Curated sample-data set (replaces fixture ingest) | merged | [#562](https://github.com/companionintelligence/CI-Planning/pull/562) |
| Synthetic fixtures (emails/calendar/tasks/memory-graph) | merged | [#563](https://github.com/companionintelligence/CI-Planning/pull/563) |
| Scrub pass 1 (video staging, ops scripts, docs, a test file) | merged | [#564](https://github.com/companionintelligence/CI-Planning/pull/564) |
| Scrub pass 2 (a mockup HTML file, bare "Rek" in 5 tests, a 2nd script copy) | merged | [#565](https://github.com/companionintelligence/CI-Planning/pull/565) |
| Git history rewrite (36 branches + 4 tags, force-pushed) | **done, not a PR** | commit `51ee7028` |

## What is NOT done — pick one of these up next

### 1. Screenshot / video re-capture (was always going to be separate)

`docs/screenshots/*.png`, `docs/ui/*.png`, and every still under `video/assets/shots/`
still show the OLD fixture-derived content (client names, task titles, the AI
briefing text) baked into pixels. Synthetic *data* fixed the database; it did nothing
to images already committed. Two jobs, different size:

- **`docs/screenshots/` and `docs/ui/` (10 static app screenshots)** — smaller. Seed
  the curated sample data (`POST /api/demo/sample-data`, admin-scoped — see the other
  handoff's *Running the app* section for the port-3901 recipe), drive the app with
  CDP, re-shoot each one at the same viewport/theme the original used.
- **`video/assets/shots/*.png` (18 files, mobile+desktop pairs) and the rendered
  product video itself** — bigger. `video/scripts/stage-data.sh` (fixed in #564 to
  use synthetic company names) is the actual staging script; it needs to be RUN
  against a real instance and the shots re-captured, then the video re-rendered per
  `video/README.md`'s pipeline. This is real production work, not a quick pass — budget
  it separately.

Read `video/README.md` first; it documents the full capture pipeline and was kept
in sync with the renamed companies in #564.

### 2. The GitHub PR-ref residual exposure (flagged, not closed)

The history rewrite force-pushed 36 branches and 4 tags with the real content
removed. **It did not and cannot remove `refs/pull/N/head`** — GitHub retains one for
every PR (509 of them here) server-side, independent of what gets force-pushed to
branches. Anyone with repo access can still `git fetch origin refs/pull/N/head` for
any PR that touched the fixture files (at minimum whichever PR first added them, plus
#490/#491/#506/#507 and others found mid-audit) and get the pre-rewrite blobs.

Two ways to actually close this, neither of which git itself can do:
- **Open a GitHub Support ticket** asking them to purge cached PR refs/views. Works
  for private repos; how thorough it is in practice is untested here.
  <br/>Alternative: no ticket needed for a truly private repo (only the owner + explicit
  collaborators can read `refs/pull/N/head` on private repos) — this only matters
  once the repo goes public, so the practical order is: do this **before**
  publishing, not urgently now.
- **Publish from a fresh repo instead.** Keep this repo private forever as working
  history; push a squashed, PII-free initial commit to a NEW public repo for the
  CI-Hub marketplace listing. No rewrite risk, no PR-ref residue, guaranteed clean —
  this was one of the options discussed before the rewrite even started, and it is
  still on the table as the belt-and-suspenders move right before going public.

**Whoever handles publishing to CI-Hub needs to know about this before they do it.**
It is the one open item in this handoff that is actually load-bearing for the stated
goal (ship to the marketplace) rather than cosmetic.

### 3. Spot-check the purge (confidence, not a known gap)

The rewrite was verified by four iterative broad sweeps (dump every blob once, grep
the dump, read what comes back) — each pass found something the previous keyword list
had missed, which is exactly why a keyword list is the wrong verification tool. The
last pass came back clean, but "the search stopped finding things" is not a proof of
absence. If you have five minutes: `git clone` fresh, dump all blobs
(`git rev-list --all --objects | git cat-file --batch=...`), and read through it once
more with fresh eyes before this repo is trusted as public-safe.

### 4. A real (unrelated) product gap, flagged in passing

`server/src/services/demo-data.ts`'s header note: **a habit task carrying `task_time`
gets PACKED into the workday window by `engine/patterns-place.ts`, not pinned at its
stated clock time**, on any day the routine packer actually runs. The demo seed works
around this by writing the pinned meal blocks directly and using the packer's own
per-day marker to make it stand down — see that file's `pinMealsForToday` doc comment
for the mechanism. The underlying gap is real product behavior, independent of the
demo, and wants its own fix. Not started.

### 5. `CP-h-doc` worktree is orphaned (pre-existing, not caused by this wave)

`/home/ci/devel/ci/CP-h-doc/.git` points at
`/home/ci/devel/ci/Companion-Planning/.git/worktrees/CP-h-doc`, a path from before the
repo was renamed `Companion-Planning` → `CI-Planning`. That directory no longer
exists. This predates the history rewrite (confirmed at the start of the branch
audit) and is unrelated to it — `git worktree repair` or just deleting the stale
worktree entry would fix it, but nobody asked for that yet.

## What shipped, and what it cost to find

- **#562** — the curated sample set (3 tasks, 5 habits, 1 objective + 3 steps, a
  Deep-work Time Block on today). Caught its own real bug live: the routine packer
  ignores `task_time` (see gap #4 above), found only by seeding against a RUNNING
  instance and reading the actual placed times — a unit test alone would have passed
  with the meals silently packed at the wrong hour.
- **#563** — synthetic fixtures. Retested twice on purpose; the second full-suite
  pass caught two self-inflicted mistakes (an id-scheme rename that broke a
  lookup-by-id test, and an over-broad sed that corrupted a test file's own
  self-contained fixture unrelated to the one being fixed).
- **#564, #565** — two more scrub passes, both triggered by building the history
  rewrite's replace-text map. **The lesson that mattered most this wave:**
  keyword-driven greps only find what you already know to search for. Dumping every
  blob in every ref ONCE and reading the dump is what actually surfaces the unknowns
  (a UI mockup file nobody had thought to check, a bare company-name token used as
  sample text in five otherwise-unrelated test files, a second copy of a script with
  the same leak). That method should be the DEFAULT for this kind of audit, not the
  fallback after keyword search runs dry.
- **The rewrite itself** — four iterations for the reason above, verified by literally
  diffing the rewritten checkout against the live tree (`diff -rq`) before pushing,
  which is what caught a real self-inflicted regression: a broad regex redaction rule
  had silently corrupted `migrations/0122_scrub_seed_owner.ts`'s scrub-guard literal —
  the ONE place in the whole repo where that exact string is functionally load-bearing
  rather than just a leak. A test suite pass would NOT have caught this (both the
  migration and its test got the same wrong literal, so they stayed internally
  consistent and green) — only the diff-against-truth caught it.

## Code map

| What | Where |
| --- | --- |
| Sample-data seed | `server/src/services/demo-data.ts` — `seedDemoData`, `pinMealsForToday` (the routine-packer workaround) |
| Sample-data endpoint | `POST /api/demo/sample-data`, `server/src/routes/demo.ts` — admin-scoped, idempotent |
| Personal DB backup | `~/ci-private/companion-planning/` (chmod 700/600) |
| Local dev DB override | `server/.env` (gitignored) — `DB_PATH` points at a throwaway file, NOT the personal DB |
| Synthetic fixtures | `server/test/fixtures/{emails,calendar,tasks.md}`, `server/fixtures/memory/graph.json` |
| Video staging (now synthetic) | `video/scripts/stage-data.sh`, `video/README.md`, `video/capture.config.mjs` |
| The scrub-guard exception | `server/src/db/migrations/0122_scrub_seed_owner.ts` + `server/test/seed-owner-scrub.test.ts` — MUST keep the literal `liam.broza@gmail.com`; it is the migration's match target, not a leak |

## Running the app / verifying

Same recipe as the Focus × Time Blocks handoff (`docs/HANDOFF-2026-08-14-focus-timeblocks-phases-1-7.md`)
— port 3848 is usually held by the systemd instance; run the API elsewhere
(`DB_PATH=/home/ci/ci-dev/companion-planning/dev.db PORT=3901 npx tsx src/index.ts`)
against a throwaway DB, never the personal one. To see the sample data:

```bash
curl -s -X POST http://127.0.0.1:3901/api/demo/sample-data
```

Idempotent — a second call reports `skipped` rather than duplicating.

**Never re-run `git filter-repo` against this repo's real remote without a fresh
mirror clone and the full verify-before-push discipline this wave used** (diff the
rewritten checkout against live HEAD, run the full test suite against the rewrite
itself, confirm origin hasn't moved since you cloned, THEN push). A force-push to 36
branches and 4 tags is not something to redo casually.

## Open questions for the owner

- **Does the GitHub Support ticket (item 2) need to happen before or independent of
  publishing to CI-Hub?** This handoff assumes "before" but that is a product-timeline
  call, not a technical one.
- **Is the "fresh repo for public, this one stays private forever" option (also item
  2) the actual plan, or was it a fallback?** If it's the plan, items 1 (screenshots)
  and 3 (spot-check) matter less — a squashed initial commit to a new repo makes both
  moot. If this repo is meant to go public as-is, they still matter.
