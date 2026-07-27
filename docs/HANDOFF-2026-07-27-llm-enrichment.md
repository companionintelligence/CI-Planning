# Handoff — 2026-07-27 · LLM enrichment upgrade + launch state

> ## Read this box first
>
> - **Shipped and pushed** to `claude/local-project-launch-cac310` → **PR #422** (5 commits).
>   Server suite **192 files / 2159 tests green**; both typechecks clean.
> - **The enrichment upgrade below is SPEC ONLY — not built.** Decisions are locked; the
>   code is not written.
> - **Two launch blockers remain open** (§6). Neither is caused by the work in #422.
> - **One verified engine gap** (§3.3) contradicts a stated intent and should be decided
>   before the enrichment work lands, because the enrichment writes the very field it affects.

---

## 1. Locked decisions (owner, 2026-07-27)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Block↔task matching stays TAG-based.** No priority field is added to `time_blocks`. | No migration. Priority keeps its current role: it *orders* tasks inside a block, it does not gate entry. |
| D2 | Work time block → work-tagged tasks; Relationships time block → relationship-tagged tasks. | This is the intent to preserve. Already true for direction; **see §3.3 for the category half**. |
| D3 | "Best time" = **band by default, concrete time only when the user's own words imply one.** | `"gym after work"` → band `evening`; `"standup at 9"` → `task_time 09:00`. Bands feed the existing gap-finder rather than pinning. |
| D4 | Memory enrichment is **NOT on the interactive quick-add path.** | An ✨ button on the task chip (on demand) + a nightly cron job. Keeps quick-add fast and sidesteps the CI-Server round-trip entirely. |
| D5 | **Subtasks are suggestions only.** | Never create a subtask without explicit user confirmation. Surfaces as pickable chips. |
| D6 | Marketplace (`CI-Marketplace/apps/ci-planning`) and CI-Portal are **out of scope**. | Reverted; both untouched. See §6. |

---

## 2. What shipped in PR #422

Five commits, independently reviewable:

1. `fix(prod)` — `SESSION_SECRET` auto-provisions (persisted `.session-secret`, 0600, beside
   the DB); Dockerfile reads `/data/.env`; `dev`/`start`/`migrate` load `.env` at all
   (there was no dotenv, so `pnpm dev` silently ignored `server/.env`).
   ⚠️ Its subject overstates: with D6, the container still needs `AUTH_MODE` — see §6.1.
2. `fix(plan-week)` — "Let Auto place it" targets the branch's own day/time picker instead
   of the global `selectedDay()`. Tasks *were* being placed, on a day nobody was looking at.
3. `fix(quickadd)` — direction-classifier grounding (definitions, not bare labels).
   Verified live: `Dad's birthday → home`, `Pipeline hygiene → work/career`,
   `Volunteer at the food bank → community/growth`.
4. `feat(ui)` — DUE card → button + modal; stars moved up; day-type picker into the Planner
   header; schedule-an-existing-task search in the Add wizard; honest Memory status.
5. `fix(llm)` — see §5.

---

## 3. Engine enforcement — verified, with one gap

Checked directly against `server/src/engine/autoplan.ts`. Do not re-derive; these are read
from the live code.

### 3.1 Direction windows ↔ direction tags — ✅ ENFORCED

`autoplan.ts:830-846` (Pass 2a). For each staged task it maps the task's tag names to
direction-tag ids; **a task with no direction tag is skipped entirely** (`continue`), and
placement only ever targets `patWindows[dirId]` for the task's *own* directions. A Home
window can therefore only receive Home-tagged tasks. Per-direction `auto_fill=false` also
removes the task from the workday fallback (`directionGatedOffIds`).

### 3.2 Tag Plans ↔ tags — ✅ ENFORCED

`autoplan.ts:773-776` (Pass 1). A Plan container's tags are matched against the task's tags:

```js
const planTags = [...weights.keys()];
cands = staged.filter((t) => planTags.some((name) => t.tags.includes(name)));
```

Priority appears only in `orderForPlan` / the catch-all sort — it never filters. Consistent
with D1.

### 3.3 ⚠️ Category Plans ↔ categories — **ASYMMETRIC (verified gap)**

The two sides of a category block use **different** category mechanisms:

| side | source of truth |
|---|---|
| the **block's** category | `entity_categories` — the Phase B (0134/0135) store, i.e. the 1–3 picker (`autoplan.ts:169, 200, 676`) |
| the **task's** eligibility | `entity_tags level>1` joined to `tag_categories` — the *old* 0069 intention→category grouping (`categoryCandidates`, `autoplan.ts:220-245`) |

**Consequence, directly against D2:** a task the user explicitly tagged *Relationships*
using the Phase B category picker is **not** matched by a Relationships time block, unless
it also happens to carry an intention tag that is grouped under Relationships.

This matters for the enrichment work because §4 has the LLM assign `categories`
(= `entity_categories`). Under the current code those assignments **do not** affect category
block matching at all — the feature would look wired and do nothing, the same
misleading-success class as §5.

**Decision needed before building §4.** Options:
- **(a)** Make `categoryCandidates` also accept tasks whose own `entity_categories` include
  the block's category (union with today's intention-grouping rule). Backward compatible;
  makes D2 true for the new picker. *Recommended.*
- **(b)** Leave as-is and have the enrichment write intention tags that are grouped under
  the category instead — indirect, and fights the Phase B model.
- **(c)** Leave as-is and accept that category blocks ignore the category picker.

Not fixed in #422: it is a behavior change to the placement engine and deserves its own
review, not a drive-by inside an LLM commit.

---

## 4. Enrichment upgrade — SPEC (not built)

Goal: quick-add should produce a genuinely useful task, not just a title. All of it rides
the existing **preview → confirm** doctrine (`/api/tasks/quick/parse` is zero-write and the
wizard hydrates its own fields), so nothing below writes without user approval.

### 4.1 Priority rubric — the qualifiers to put in the prompt

The gap today is that the prompt says only *"1 is highest priority"*, which is not a rubric.
Priority is an integer 1–5 (`schema.ts:57`); the UI exposes four buckets
(`TaskCard.tsx:22`): P1=1, P2=2, P3=3, Later=4.

| bucket | qualifier for the model |
|---|---|
| **P1** | Urgent **and** important. A hard deadline inside ~48h, or someone/something is blocked until it is done. There is a real consequence if it slips today. |
| **P2** | Important, not urgent. Real consequences, no imminent deadline. Most meaningful work lands here. |
| **P3** | Normal / routine (**default**). Should happen; no consequence if it slips a few days. |
| **Later (4)** | Optional / someday. Nice to have, no consequence if never done. |

Rule for the prompt: **when uncertain, choose P3** — the current behavior of guessing high
turns the priority axis into noise.

### 4.2 Duration estimate

Already a field (`estimatedMinutes`) but unguided. Give the model anchors (a call ≈ 15m, a
focused writing block ≈ 60–90m, an errand ≈ 30m incl. travel) and require a multiple of 5.
The engine already defaults to 30m when null (`autoplan.ts:33 DEFAULT_EST_MIN`), so a bad
guess is worse than none — instruct it to return null when it genuinely cannot tell.

### 4.3 Best time (D3)

Return **`timeOfDay: morning | afternoon | evening | any`** plus a short reason, and
`taskTime` **only** when the entry's own words imply a clock time. The wizard's existing
`proposeSlot` (`client/src/lib/propose-slot.ts`) then picks a real open slot *inside* the
band, so this composes with direction windows and busy blocks instead of overriding them.
Do **not** write `task_time` from a band — that would hard-pin via the AD1 pin pass
(`autoplan.ts:725-755`) and defeat conflict-aware placement.

### 4.4 Subtask brainstorming (D5)

Only for tasks the model flags complex. Keep it a **second** LLM call, gated on that flag,
so simple quick-adds stay fast. Returns `subtasks: string[]` (3–6, imperative, each
independently doable). Surface as pickable chips in the wizard; creating them uses the
existing `parent_id` path (`ElementWizard` already accepts `parentId`). **Never auto-create.**

### 4.5 Memory enrichment (D4)

Not on the quick-add path. Two entry points, sharing one service:
- **✨ button on the task chip** — on demand, for one task.
- **Nightly cron job** — sweeps recent tasks. Register in `server/src/jobs/`; note
  `RUN_NOW_KINDS` (`routes/jobs.ts`) controls what the Jobs page can trigger.

Uses `graphSearch(owner, query, {limit})` (`connectors/memory.ts:599`) to pull related
items, then asks the model for a **description** and a better direction/category call.
Must degrade silently when memory is `off`/unreachable — `memoryCreds` returns null and
`MEMORY_MODE` unset means off (see §6.3).

### 4.6 Shape

One structured call for the common path (direction, categories, tags, priority,
estimatedMinutes, timeOfDay, isComplex), plus the gated subtask call. Keep the existing
constrained-vocabulary contract in `mergeEnrichment`: anything outside the owner's real tags
is dropped, never invented. Extend `ParsedQuick` (`engine/quickadd.ts:3`) for the new fields.

⚠️ **Model constraint that shapes all of this:** thinking models return an empty string under
`format:"json"` (§5). Selection now excludes them automatically, but any *new* prompt must
still be tested against a live model — a silent `""` reads exactly like "the model had
nothing to say".

---

## 5. The LLM pipeline fix (shipped, commit 5)

Symptom: Settings showed "Ollama available ✓ 7 models" while every AI call was dead —
`{"llm": false}` and `model 'qwen2.5:0.5b' not found`.

Two defects: the built-in default tags are not pulled on most machines, and the health check
only proved Ollama *answered*, never that the model the app would request existed.

- **Selection** (`lib/models.ts`): Settings override → env pin → built-in default *when
  installed* → auto-select from `/api/tags`. Driven by Ollama's own metadata, not a
  blessed-name list: `embedding` → embed tier only; **`thinking` → excluded from generation**
  (verified: returns `""` under `format:json`); the rest ranked by parameter count (smallest
  for fast, largest for quality). Missing capability metadata degrades open.
- **Honesty**: `status()` reports the *effective* models plus `ready` and `missingModels`.
  `aiAvailable()` keys on `ready`, so AI controls hide rather than dangle. Settings has three
  states: green ready / amber "running, but `<model>` not installed" / red unreachable.
- **Hermeticity**: the installed-model cache is deliberately **not** filled under
  `NODE_ENV=test`. With Ollama up, auto-selection hands agents a real model, so the suite
  performs genuine inference — `run-now` went 1s → 124s and the parallel suite timed out
  (2 failures). Selection tests set the cache directly via `setInstalledModels`.

Verified with zero manual config: boot logs
`Ollama ready — small=llama3.2:latest medium=llama3.1:latest`, and quick-add returns
`llm=true`, `Dad's birthday → home`.

---

## 6. Open blockers (not caused by #422)

### 6.1 The production container still needs `AUTH_MODE`

`NODE_ENV=production` is set in the Dockerfile; `AUTH_MODE` defaults to `test`; the
fail-closed guard refuses to boot:

```
FATAL: AUTH_MODE=test is forbidden in production — set AUTH_MODE=standalone or sso
```

With D6 the marketplace can't supply it, so the options are `/data/.env` (now supported by
#422) or a Dockerfile default. Measured:

| mode | result |
|---|---|
| `standalone` | Boots clean, health 200, unauthenticated API → **401**, no baked-in password. But API-key only — **the browser PWA has no login path**. |
| `sso` + `DISABLE_OIDC=true` | Real login UI, but `ensureLocalAuthBootstrap()` **throws** without `AUTH_DEFAULT_PASSWORD`, and baking a shared password into a public image is unacceptable. |
| `sso` + CI-Portal | Blocked — see §6.2. |

The guard was deliberately **not** weakened.

### 6.2 CI-Portal SSO is unregistered

`ci-planning` is absent from CI-Portal's first-party client registry
(`FIRST_PARTY_APP_IDENTITIES` holds only `ci-hub`, `ci-server`, `ci-import-tools`), and
CI-Portal's own `architecture.md` lists open client registration as unbuilt through
2026-09-15. Out of scope per D6.

### 6.3 Memory needs env the container doesn't set

`MEMORY_MODE` unset ⇒ **off** (the connector reports unavailable regardless of stored
credentials), and `CP_KEK_B64` unset ⇒ credentials can't be stored at all. Both are
required for §4.5. Reachable via `/data/.env`.

Separately: the demo host `ci-memory-demo-ci-lab.companionintelligence.com` serves **HTML,
not the API** (`/graph/data` → 200 `text/html`; `POST /v1/events` → 405). A real CI-Server
API base URL is needed before memory enrichment can be tested end-to-end.

---

## 7. Repo facts worth carrying

- **Ollama gotcha:** the app's default tags (`qwen2.5:0.5b`, `gemma3n:e4b`) are usually not
  installed. Auto-selection now handles it, but when "AI does nothing", still diff the
  effective model (`/api/integrations` → `smallModel`) against `GET :11434/api/tags`.
- **`thinking` models return `""` under `format:json`** — the single most confusing LLM
  failure in this codebase. `qwen3.5:*` / `qwen3.6:*` are affected; `llama3.x` are not.
- **Client typecheck can pass on a stale `tsconfig.tsbuildinfo`** while CI fails — delete it
  before trusting a green local run.
- **The server has no dotenv by default** (fixed in #422 for dev/container, but any *new*
  entry point must opt in with `--env-file-if-exists`).
- `GOOGLE_CONNECT_ENABLED` (`client/src/lib/flags.ts`) is currently **true**; flip to false
  for a Memory-only launch.
