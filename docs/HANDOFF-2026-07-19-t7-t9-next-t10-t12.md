# Handoff — T7/T8/T9 shipped, next up T10 → T11 → T12 (2026-07-19)

> **Read this before opening any of T10/T11/T12.** It exists to save you from re-discovering
> the same three or four traps every FTUE ticket so far has hit. It is not a substitute for
> reading the actual issue and the actual current code — do both anyway (see "Process" below).

## TL;DR

- **T1–T6**: merged to `main` (PRs #377, #379). Closed on GitHub.
- **T7 + T8 + T9**: implemented, tested, bundled into **[PR #380](https://github.com/companionintelligence/Companion-Planning/pull/380)** (open, not yet merged — title/body cover all three). Issues #343/#344/#345 closed out with checkboxes ticked and completion comments documenting deviations.
- **Migration head on this branch: `0131_planning_sessions`** (T1's). The next free slot is **`0132`**. Every ticket draft below cites a stale/wrong slot — see T11's section.
- **Next up, in order**: **T10 (#346)** → **T11 (#347)** → **T12 (#348)**. T12 genuinely can't start until T11 is *built*, not just unblocked (T12 depends on a wizard-shell contract T11 defines). T10 has no dependency on T10/T11 and could in principle go first or in parallel, but you were asked to do them sequentially — do that.
- **The single biggest recurring finding across T1–T9**: every ticket in this set was drafted against a migration-head/code snapshot from days before it was implemented. By the time each one landed, dependency tickets had shipped with different file layouts, function names, or UI shapes than the draft assumed. **Every single ticket so far required at least one real correction against its own pinned conventions.** Budget time for this — it is not optional diligence, it is the actual job.

## Process (the user's standing instructions — follow exactly)

For **each** of T10, T11, T12, in order:

1. **Read the GitHub issue in full** (`gh issue view <n> --repo companionintelligence/Companion-Planning`). Don't skim — read Goal, Non-goals, Pinned Conventions, Before Implementation, Files Impacted, Definition of Done, Tests, Acceptance Criteria, Subtasks.
2. **Check the pins are up to date before writing any code.** Every ticket's "Pinned conventions" section cites specific files/lines/function names "as of" some earlier snapshot. Open those files and confirm the citation is still accurate. When it isn't (it usually isn't, at least partially), the ticket is wrong and the live code is right — implement against reality and say so explicitly in your work, don't silently pick one.
3. **Implement + test.** Run the verification commands the ticket lists (typecheck/test/build for both server and client) — don't report done until they're actually green.
4. **Update the GitHub issue before reporting completion**: edit the issue body to check off every DoD/Tests/Acceptance/Subtask box that's genuinely satisfied (leave unchecked or annotate anything that isn't), and post a comment stating what shipped, what verification you ran, and — critically — any place your implementation diverges from the ticket's literal text and why. Don't bury deviations in code comments only; put them in the issue comment too, the same way every ticket in this set did.

A `sed`-based pattern that works for checking boxes in bulk (used for T7/T8/T9):
```bash
gh issue view <n> --repo companionintelligence/Companion-Planning --json body -q .body > /tmp/body.md
sed -E 's/^(- )\[ \]/\1[x]/; s/^([0-9]+\. )\[ \]/\1[x]/' /tmp/body.md > /tmp/body-checked.md
gh issue edit <n> --repo companionintelligence/Companion-Planning --body-file /tmp/body-checked.md
gh issue comment <n> --repo companionintelligence/Companion-Planning --body "..."
```
Only check a box if it's actually true. If a specific DoD line can't be satisfied as literally written (see T8/T9 below for real examples), leave it checked ONLY if the underlying intent is met a different way, and say exactly how in the comment — never silently reinterpret without flagging it.

## What shipped this session (T7, T8, T9)

All three landed on branch `claude/update-t1-t5-github-ec8f8a`, bundled into **PR #380** (not yet merged — check its state before you branch off `main` vs off this branch; see "Branching" below).

### T7 (#343) — LLM hybrid follow-up steps
`POST /api/plan-week/next-step`: a `renderCopy`-backed question + 3-option rewrite on top of a branch's own fixed deterministic question/options. Never 503s.
**Finding:** the ticket assumed every T3/T4/T5 branch shares a generic "question + top-3" moment. None do — T3 is a multi-step wizard, T4 a task-picker, T5 a read-only recap. Wired the hybrid layer into **T4 only**; T3/T5 got none. Documented in `PlanWeekScheduleTasks.tsx`'s header.

### T8 (#344) — parse free-text answer to scheduling intent
`POST /api/plan-week/parse` reuses `parseInstruction` directly (never `instructPlan`) — zero writes, same 503/422 mapping as `/api/plan/instruct`.
**Finding (important for anyone touching `PlanWeekAssistant.tsx` again):** its `PromptStep` component — the shared "question + chips + free-text" primitive T2 built — is **dead code in the live app**. All three shipped branches (T3/T4/T5) render their own bespoke component instead of `PromptStep`, so `PromptStep`'s fallback render path (only used when a `BRANCHES` entry has no `component`) never executes. T8 implemented and tested its contract directly against `PromptStep` per the ticket's literal scope, but nothing a real user does today reaches this code. If a future ticket wants T8's free-text-parse feature to actually be reachable, it needs to either retrofit a branch to use `PromptStep` or give T8 a different landing spot — that decision hasn't been made.

### T9 (#345) — LLM authors the week's plan order
`authorPlanOrder` now returns `'llm' | 'deterministic'` truthfully at every exit (including the already-authored no-op). `POST /api/auto/run` (REST + GraphQL) takes an opt-in `smart` flag; `AutoResult.llm` is true iff any authored day used the LLM.
**Finding:** the ticket's own Tests section self-contradicts (asserts `result.llm !== true` for "smart off" while also asserting day-0 is `'llm'` in the same scenario — impossible given the DoD's own definition, since day 0 has always used the LLM gate independent of the new flag). Implemented per the DoD's literal wording; documented in `plan-week-author.test.ts`'s header.

**Common thread across all three**: the shell (`PlanWeekAssistant.tsx`) and its three branches (`PlanWeekFill.tsx`, `PlanWeekScheduleTasks.tsx`, `PlanWeekReviewBranch.tsx`) do **not** share a common UI primitive in practice, despite T2's own header comment implying they do ("T3/T4/T5 drive real flows through it" — false, checked directly). **If T10/T11/T12 assume anything about a shared stepper/prompt primitive across these branches, verify it against the actual component files, not the comment.**

## Lessons for T10, T11, T12 specifically

### T10 (#346) — consolidate/summarize planning logs
Depends on T1 + T6 (both merged). No blocker. Adds `POST /api/plan-week/sessions/consolidate` reusing the `weekly_review` `renderCopy` surface.

**Pre-flagged issue**: the ticket's Pinned Conventions step 3 says to bind the deterministic digest's "action count" and "created-task count" to "whatever T1 records for" those — hedged with "confirm... expected... whatever," meaning the ticket author wasn't sure these fields exist. **They don't.** T1's actual shipped `planning_sessions` schema (migration `0131_planning_sessions.ts`, confirmed directly this session) is:
```sql
id, owner_id, started_at, ended_at, entry_branch, status, llm_used, transcript, summary, created_at
```
There is no count column of any kind. "Action count" / "created-task count" will have to be derived by parsing `transcript` (a JSON array of `{role, text, ts, kind?}` entries) — e.g. counting entries whose `kind` starts with `plan_week:` and matches a placement pattern, or just falling back to `transcript.length` as a much simpler proxy. Decide and document the choice; don't guess a column that isn't there.

Also: the ticket says "branch" as if it's a column name — the real column is **`entry_branch`**. And T5/T6 both anchor date-range logic on `started_at`, not `created_at` (T6's own handoff note: "no `week_start` field, temporal anchor is `started_at`") — the ticket's digest wants a `min → max` date range; use `started_at` for consistency with T5/T6, not `created_at` as literally written, unless you check and they're identical in practice.

### T11 (#347) — first-run onboarding wizard
Depends on T2 (merged). No blocker in principle, but **two of its "Pinned conventions" are simply wrong** and one assumption needs verification before you design anything:

1. **Migration slot: the ticket says `0128_owner_onboarded` ("T1 takes 0127... confirm the next free slot is still 0128 at implementation time").** Wrong on both counts. T1 actually took **`0131`**. Slots 0127–0130 are already used by `life_priorities`, `sleep_hours`, `objective_archive`, and `purge_objectives_job` (all landed on `main` while this ticket set was being drafted/built). **The real next free slot is `0132`.** Confirm this yourself with `ls server/src/db/migrations/` before you write the migration — don't trust either the ticket's number or this handoff's number blindly, re-verify, since more slots may have been claimed since this was written.
2. **"Reuse the T2 stepper primitive"** — verify this actually exists as something reusable before designing the wizard around it. `PlanWeekAssistant.tsx` (T2) has an internal step state machine (`Step`, `BRANCHES`, `setStep`) that is **not exported** as a generic component, and its one shared primitive (`PromptStep`) is a question+chips+free-text input — not remotely the shape of an onboarding form (name/email fields, a TZ confirm + two time inputs, a 3-option trust dial). Read `PlanWeekAssistant.tsx` yourself before assuming there's a "stepper" to import; there almost certainly isn't one in a form generic enough to reuse, and you may need to just build `OnboardingWizard.tsx`'s own simple step signal (which is fine — say so, don't force a fake reuse).
3. **Good news**: T1's `entry_branch` enum **already includes `'onboarding'`** (`client/src/lib/api.ts`: `export type PlanWeekEntryBranch = 'fill_week' | 'schedule_tasks' | 'review' | 'onboarding'`) — confirmed directly. The ticket frames this as something "T2" owns and might need coordination for; it doesn't, T1 already anticipated it. `api.planWeek.session.open('onboarding')` should just work.
4. Every `client/src/lib/api.ts` line-number citation in this ticket (L482, L298, L465, L738, L745) is near-certainly stale — T7/T8/T9 alone added ~60 lines to that file this session, and T6 touched `Settings.tsx` extensively. The **methods** (`api.owner.updateProfile`, `api.prefs.update`, `api.auth.me`) almost certainly still exist under those names; just don't trust the line numbers, re-grep.

### T12 (#348) — connect-source + first-sync + empty-states
**Hard dependency on T11 being built**, not just unblocked — T12's own header says it "relies on this contract from T11": a wizard that renders regardless of route, per-step render slots for its Step 3/5, and an `openOnboardingAt(step)` store helper (with an explicit fallback: if T11 didn't land that exact helper, add a minimal signal yourself rather than creating a second competing one). **Do not start T12 until T11's `OnboardingWizard.tsx` actually exists on your branch** — read its real shape before designing T12's slot-filling, the same way every other ticket in this set had to re-verify its dependency's *shipped* code, not its *drafted* spec.

Two more things worth flagging up front (from the ticket body, not yet independently verified this session — verify them yourself when you get there):
- It wants a **new** `POST /api/jobs/run-now` (owner-scoped, write-scope gated) distinct from the existing admin-only `POST /api/jobs/:id/run` — confirm that route really doesn't exist yet (`grep -rn "run-now" server client`) before adding it.
- It wants `config.google.mode` to be settable to `'fixture'` at runtime via the existing admin-gated Settings → Connections config (today it only flips `live`/`off`) — verify `GoogleConfigState.mode`'s current type actually already includes `'fixture'` as the ticket claims, since it's the kind of detail this whole ticket set has gotten wrong before.

## Branching / PR strategy

T7/T8/T9 are on `claude/update-t1-t5-github-ec8f8a`, bundled into the still-open PR #380. Two live options when you start T10:

- **If #380 has merged by the time you start**: branch fresh off `main` (it will include T1–T9). Simplest, do this if possible.
- **If #380 is still open**: you can branch off `claude/update-t1-t5-github-ec8f8a` directly so you're not blocked, but say so explicitly in your PR description (the base won't be `main`) and flag it needs #380 merged first, or rebase before merging. This repo has been bitten by exactly this "stacked PR merged into the wrong base" confusion before (see `project_q2_table_consolidation` memory / PR #209's history) — don't repeat it silently.

Either way: **fetch `origin/main` and check `git merge-base --is-ancestor HEAD origin/main` (or the reverse) before you start**, the same fast-forward-first discipline used for T7→T8/T9 this session.

## Repo facts worth carrying over

- **Verification commands** (run from `server/` and `client/` respectively): `pnpm typecheck`, `pnpm test` (this project's `test` script already runs `vitest run` — passing extra args like `-- foo` doesn't reliably filter to a subset in this repo's config, it tends to just run the whole suite; that's fine, the full suite is the real gate anyway), `pnpm build` (client only). As of this handoff: server suite is **2055 passed / 3 skipped**, client is **526 passed**. Both clean typecheck/build.
- **Long-running test commands**: the full server suite takes ~4 minutes, client ~30s including its own transform/import overhead — run them in the background and wait for the notification rather than polling.
- **`gh issue edit --body-file`** replaces the whole body — always fetch-and-modify, never hand-author a fresh body from memory, or you'll clobber content.
- **Ollama-only LLM invariant** still applies: any new AI-touching surface goes through `renderCopy` (microcopy) or `parseInstruction`/`generateJson` (structured), never a raw provider call, and always degrades deterministically when Ollama is down. Every ticket in this set follows this; don't be the one that breaks it.
- **`aiAvailable()`-truthfulness rule**: never gate a UI affordance on the client-side `aiAvailable()` flag alone if the server can tell you what actually happened (`source`/`llm` fields in T7/T9's responses). T9's whole point was fixing exactly this class of bug pre-emptively for the "(AI)" marker — carry the same discipline into T10's "(AI)" badge (gate on `source === 'model'`, not `aiAvailable()`).
