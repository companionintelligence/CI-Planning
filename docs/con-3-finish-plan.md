# Finish CON-3 — make `entity_tags` the tag read-path (wave plan)

> **Status: PLAN ONLY — no code moved.** Draft for review, 2026-06-22. Sub-plan of
> [phase-0-reconciliation-plan.md](phase-0-reconciliation-plan.md) §5b.
>
> **Decision (with the user):** finish CON-3. `entity_tags` becomes the **read path**
> for task tags; **`task_tags` is dropped** (its rows already live in `entity_tags` as
> level-1); the denormalized **`.tag` mirror** on `time_blocks`/`patterns` **stays**.
> Tasks have no `.tag` column, so post-migration a task's tags live **only** in
> `entity_tags`.

## The through-line (why this is safe)
Writes **already dual-write** `task_tags` + `entity_tags` with identical tag ids
([tasks.ts:559-565](../server/src/routes/tasks.ts:559)), and the 0033 backfill copied
every existing row ([0033:57](../server/src/db/migrations/0033_entity_tags.ts)). So the two
stores are **already in parity** — we just haven't *read* from `entity_tags`. That makes
the risky part (flipping reads) **behavior-preserving and reversible**: while
`task_tags` is still written, any read-flip can be reverted instantly. We only burn the
bridge (drop `task_tags`) in the last wave, behind a green parity gate.

**One invariant to hold everywhere:** `entity_tags.entity_id` has **no FK** (it spans
tables) — integrity is app-enforced by the tag-repo ([services/tags.ts](../server/src/services/tags.ts)).
Every **hard delete** of a task must call `removeEntityTags('task', id)` or rows orphan.
(Soft deletes keep the row, so they don't.)

---

## Wave map

| Wave | Goal | Reversible? | Exit gate |
|---|---|---|---|
| **W0 — Parity & gate** | Prove `entity_tags(task,level1)` == `task_tags` for every task; lock it as a standing test | n/a (test-only) | Parity test green on fixture **and** a copy of a real DB |
| **W1 — Flip reads** | Every task-tag *read* comes from `entity_tags`; `task_tags` still written | ✅ fully | Suite green; **characterization snapshot unchanged**; parity still green |
| **W2 — Drop `task_tags`** | Stop writing it; drop the table; tasks' tags live only in `entity_tags` | ❌ point of no return | `grep task_tags server/src` = migrations only; suite green; snapshot diff reviewed |

Waves are **strictly sequential**. Within a wave, the lettered tasks **fan out** (independent files → parallel owners) after the wave's prerequisite task lands.

---

## Wave 0 — Parity & gate *(small, serial, no behavior change — do first)*
The safety net W1/W2 lean on.

> **✅ DONE 2026-06-22.** [`server/test/tag-parity.test.ts`](../server/test/tag-parity.test.ts)
> added (6 cases, green); full server suite **324/324**. **Audit results:** (a) the
> `?tag=` filter rides on the serialization read ([tasks.ts:59](../server/src/routes/tasks.ts:59)) —
> **not** a separate site; (b) task `DELETE` is **soft** (no orphan), and the only hard
> task-delete (fast-task) already cascades. **Gap found & fixed:** the nightly
> `promotePossibles` wrote `task_tags` only — added the `entity_tags` level-1 mirror
> ([groom.ts](../server/src/agents/groom.ts)) so inbox-promoted tasks are now in parity.

- **T0.1 — Parity test (standing).** New `server/test/tag-parity.test.ts`: seed data, then assert for **every** task the tag-id set from `task_tags` equals the set from `entity_tags WHERE entity_kind='task' AND level=1`. Assert no `task_tags` row lacks a matching `entity_tags` row and vice-versa. This is the gate for W1 and the entry-gate for W2.
- **T0.2 — Write-parity assertion.** Extend the test (or add unit coverage) to confirm each *write* path keeps both stores in sync: create-with-tags, update-tags, recall-clone, merge, and the **groom promotion** (`possible_task_tags → task_tags` today, [groom.ts:61](../server/src/agents/groom.ts:61)). This surfaces any write site that *doesn't* already dual-write (groom is the prime suspect).
- **T0.3 — Read/write site audit (checklist).** Confirm the inventory below is complete — grep `task_tags` across `server/src` and classify each hit READ / WRITE / migration. **Open items to verify:** (a) the `GET /api/tasks?tag=` **filter** query — does it JOIN `task_tags`? If so it's a read site for W1. (b) Is there any **hard-delete** of tasks (e.g. merge discarding the merged-away task) that must call `removeEntityTags`?

**Gate:** parity + write-parity green on a fixture DB and on a copy of a real `companion.db` (run against a **copy** — the dev DB is shared across worktrees).

---

## Wave 1 — Flip the read path *(fan-out by read site; `task_tags` still written)*

> **✅ DONE 2026-06-22 (adversarially verified).** All 8 read sites now go through
> `taskTagNames` / `taskTagNamesByIds` (entity_tags · task · level-1, **`ORDER BY tag_id`**
> to reproduce the old `task_tags` PK read order, so the client's `tags[0]` primary tag is
> stable). `tsc` clean; server suite **325/325**. A 6-lens adversarial review found & fixed:
> (1) a seed-script parity hole — `seed-test-data.ts` filler now mirrors `entity_tags`;
> (2) an ordering regression — was `ORDER BY name` (alphabetical), now `tag_id`, **pinned by a
> new order-sensitive test** (the baseline snapshot can't catch it — its normalizer sorts arrays);
> (3) a seeder-reset orphan — `resetData()` now `DELETE`s `entity_tags`;
> (4) an unchunked IN-list — `taskTagNamesByIds` now chunks at 500 (no 32766-param 500 on the
> unbounded list endpoint); (5) a normalization gap — `attachTags` now uses canonical
> `normalizeTagName`. Integration + completeness-critic verdicts: clean. Still reversible —
> `task_tags` remains written; nothing dropped (that's Wave 2).

**T1.0 — Shared reader (prerequisite; blocks the fan-out).** In [services/tags.ts](../server/src/services/tags.ts) add:
- `taskTagNames(id)` → `entityTagNames('task', id)` (thin wrapper; already exists for the generic case).
- **`taskTagNamesByIds(ids[])`** — a **batched** reader (one query, `WHERE entity_id IN (…)`, grouped) to avoid an N+1 on list endpoints. Read **level-1 only** to preserve today's behavior (no dilution — that's Phase 5). Match the existing order (`level, name`) so serialized `tags[]` ordering is stable (snapshot-safe).

Then fan out (independent — one owner each):
- **T1.1 — `routes/tasks.ts` (the big one; single owner, one file).** Replace the **six** inline `JOIN task_tags` serializers (49, 214, 259, 321, 343, 447) with the shared reader; use the **batched** variant for the list endpoint. If the `?tag=` filter (T0.3) JOINs `task_tags`, repoint it to `entity_tags` too.
- **T1.2 — `engine/autoplan.ts:70`** — repoint the task-tag matcher to `entity_tags` (level-1). Re-run `auto-placement.test.ts` with expectations **unchanged** (parity ⇒ same matches).
- **T1.3 — `engine/patterns-place.ts:53`** — repoint `tagsOf(taskId)` to `entity_tags`. Routine tag-filtered placement behavior unchanged.
- **T1.4 — any site surfaced by T0.3** not covered above.

**Gate (per task + wave):** full suite green; **`baseline.characterization` snapshot unchanged** (tag sets and order identical — if it churns, investigate before accepting); parity test still green. Because `task_tags` is still written, each task is independently revertable.

---

## Wave 2 — Stop writing `task_tags` & drop it *(fan-out by write site, then the migration)*

Fan out (independent; each ensures `entity_tags` is the sole write):
- **T2.1 — `routes/tasks.ts` writes.** Drop the `task_tags` INSERT in `attachTags` (559) — keep its `entity_tags` sync. Drop the **PATCH tag-replace** `DELETE FROM task_tags` (427) — `setEntityTagIds` already gives replace semantics — and the recall `task_tags` copy (304), keeping the `entity_tags` copy (307). (Single owner — same file as T1.1, so sequence after it.)
- **T2.2 — `agents/groom.ts` promotion.** Already dual-writes `entity_tags` (added in W0) — in this wave just **drop its `task_tags` INSERT**, leaving the `entity_tags` mirror.
- **T2.3 — `scripts/seed-test-data.ts` (46, 176)** — seed `entity_tags` instead of `task_tags`.
- **T2.4 — test setup helpers.** `server/test/helpers.ts` (+ any test that inserts `task_tags` directly) → use an `entity_tags` helper. Touches: `entity-tags`, `auto-placement`, `flight-plan`, `jobs`, `pattern-blocks`, `patterns-place`, `plan-container`, `phase5-tag-levels`.

Then serial:
- **T2.5 — Migration `0040_drop_task_tags`.** **Gate on a grep proving zero live readers/writers remain** (excluding `db/migrations/*`). Drop the `task_tags` table; remove `taskTags` from [schema.ts:281](../server/src/db/schema.ts:281). Nothing FKs *into* `task_tags`, so this is a plain `DROP TABLE` (still: own migration, idempotent, run against a DB copy first). Leave `possible_task_tags` **untouched** — it serves the Inbox and is a different store.
- **T2.6 — Tests & snapshot.** Update the remaining `task_tags` test references; **regenerate the `baseline.characterization` snapshot deliberately** and review the diff — it should show the store/identifier change only, **no value or count delta**. Replace the W0 parity test (which compares two stores) with an "entity_tags is the sole task-tag store" invariant, or retire it.

**Acceptance (greppable):** `grep -rn "task_tags" server/src` returns only the migration history (`0001` create, `0030` rebuild, `0033` backfill) + the new `0040` drop — **zero live code references**. Suite green. A task's tags resolve identically pre/post.

---

## Out of scope — what this *unblocks* (Phase 5)
Finishing CON-3 is the prerequisite for **tag levels + dilution** (smarter auto-placement: weight = `1/#tags`, top-level immune). Infra is already partly present (`phase5-tag-levels.test.ts`, the secondary-tag hook at [blocks.ts:68](../server/src/routes/blocks.ts:68)). **Not part of this plan** — it's its own phase once `entity_tags` is the read path.

## Regression hazards (specific to this work)
- **N+1 on task lists** — the batched reader (T1.0) is mandatory, not optional; add a perf sanity check on a 1k-task list.
- **`tags[]` ordering churn** — match the existing order in the shared reader or the snapshot/UI tag order shifts. Caught by the characterization snapshot.
- **Orphaned `entity_tags`** — confirm every **hard**-delete task path calls `removeEntityTags('task', id)` (T0.3 audit; covered by CON-3's orphan-free tests).
- **Shared dev DB** — `companion.db` is one fixed path across all worktrees; run `0040` and all parity checks against a **copy**.
- **Point of no return** — do not start W2 until W0 parity is green and W1 has shipped; W2's drop is irreversible without a restore.

## Suggested PRs
1. **W0** — parity test + audit (own PR; pure addition).
2. **W1** — shared reader + read-flips (one PR, or T1.1 separate from T1.2/T1.3 since they're different files).
3. **W2a** — stop writing `task_tags` (T2.1–T2.4), `task_tags` still present.
4. **W2b** — `0040_drop_task_tags` + schema + snapshot (own PR, behind the grep gate).
