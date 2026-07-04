# W — GraphQL schema design + SDL skeleton (for review)

**Status:** This began as the design / SDL-skeleton review artifact called for by
`W-graphql-crud.md`'s Definition of Done ("a representation doc — type ↔ REST route ↔
underlying table — published"). **Step 1 (bootstrap) is now built and mounted** (Apollo at
`/api/graphql`, base SDL + `viewer` + scalars + complexity limiter — see §6); the entity
types below (TagType, Task, TimeBlock, …) are the remaining, not-yet-wired skeleton.

**Decisions locked (owner, 2026-07-03):**
- **D1 Library = Apollo** — as-built: **Apollo Server 5 + `@as-integrations/koa`** (Koa 3 mount), convention-parity with CI-Server. Complexity limiting is a custom Apollo plugin on `graphql` directly (see §5), NOT `graphql-query-complexity`.
- **D2 Authoring = schema-first** — hand-authored SDL (this file), kept **diff-comparable to CI-Server's `__generated__/schema.graphql`** for shared types.
- **D4 Subscriptions = skipped** — SSE stays the one real-time channel.
- **D6 Tag model = hybrid** (already decided in `W-graphql-crud.md` §6) — specified in full below.
- **D3 (constraint):** every resolver calls the existing `services/*.ts` / route service functions — no business logic re-implemented against the DB. **D5 (mechanical):** the GraphQL context reads `currentOwnerId()` exactly as REST handlers do, across all of U's auth modes.

**Grounding (verified 2026-07-03 against live code):** CI-Server HEAD `619ec65e` (fresh); its schema at `backend/apps/api/src/domains/graphql/__generated__/schema.graphql` (1473 lines) is the convention source below. CI-Planner had **no** GraphQL dep before this phase (step 1 adds Apollo + `graphql@16`) and **31** route files. Core entities `tasks`/`blocks` have **no service layer** (logic inline in routers) — the extraction that D3 requires before their resolvers can be thin.

---

## 1. Conventions (adopted verbatim from CI-Server)

```graphql
interface Node { id: ID! }

interface Connection {
  edges: [Edge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

interface Edge {
  cursor: String!
  node: Node!
}

type PageInfo {
  endCursor: String
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
}

scalar DateTime
scalar JSON

# Polymorphic tagging, adopted 1:1 from CI-Server.
interface Taggable { tags: [EntityTagType!]! }
type EntityTagType implements Node {
  id: ID!
  label: String!
  taggedAt: DateTime!   # W4a (mig 0110): backed by entity_tags.created_at — see §5.
}
```

- **Every entity type** is `type XType implements Node`, adding `& Taggable` when it carries tags.
- **`Taggable` forward edge — DONE (W4a).** `TaskType` + `TimeBlockType` now `implement Node & Taggable`; their `tags` field resolves via `entityTagsFull(kind, id)` (services/tags.ts) → `{ id: tagId, label: name, taggedAt: created_at }`, mapped to `EntityTagType` by default resolvers (no `EntityTagType` resolver needed). Returns **all levels** (level is planner-internal, not exposed). The **reverse** edge (`TagType.entities`) is W4b.
- **Query root:** singular `x(id: ID!): XType` + plural cursor connection `xs(after, before, first, last): XConnection!`.
- **Mutations:** `input CreateXInput {…}` / `input UpdateXInput {…}` + `type CreateXPayload { x: XType, success: Boolean! }` (and `deleteX(input: DeleteXInput!): DeleteXPayload!`).
- Timestamps are `DateTime!` (`createdAt`/`updatedAt`). CI-Server's generated schema sorts fields alphabetically; for **shared** types (`TagType`) we match its field set exactly so a diff is clean — for CI-Planner-only types field order is logical/readable.

Each entity type gets a matching `type XConnection implements Connection` + `type XEdge implements Edge`. Those are mechanical and omitted from the per-type blocks below except where the type is central; a generator or copy-paste fills them in at implementation.

---

## 2. Three-way mapping (GraphQL type ↔ REST router ↔ table(s) ↔ service status)

| GraphQL type | REST router | DB table(s) | Service layer for D3 |
|---|---|---|---|
| `TaskType` (Node, Taggable) | `tasksRouter` | `tasks`, `entity_tags`, `task_dependencies` | **none — extract** (`services/tasks.ts` TBD) |
| `TimeBlockType` (Node, Taggable) | `blocksRouter` | `time_blocks`, `entity_tags` | **none — extract**; `services/block-task-sync.ts` partial |
| `BlockTemplateType` (Node) | `blockTemplatesRouter` | `block_templates` | none — extract |
| `PossibleTaskType` (Node) | `possiblesRouter` | `possible_tasks` | `services/task-promotion.ts` (promote = mutation w/ side effects) |
| `TagType` (Node, + hybrid) | `tagsRouter` | `tags`, `tag_directions`, `tag_categories`, `entity_tags` | **`services/tags.ts` (rich)** — pilot-ready |
| `PatternType`†, `PatternBlockType`, `PatternPrefType` | `patternsRouter`, `patternBlocksRouter`, `patternPrefsRouter` | `patterns`, `pattern_tasks`, `pattern_blocks`, `tag_prefs` | `services/patterns.ts`, `pattern-blocks.ts`, `pattern-prefs.ts` |
| `TagPrefType` (was CategoryPref) | `categoryPrefsRouter` | `tag_prefs` (post-S2) | `services/category-prefs.ts` |
| `DayTypeType` | `dayTypesRouter` | `day_types`, `day_of_week_map`, `day_assignments` | `services/day-types.ts` |
| `FlightPlanEntryType` | `flightPlanRouter` | `flight_plan` | none — extract |
| `SchedulingPrefsType` | `prefsRouter` | `scheduling_prefs` (~39 cols) | none — extract; see §5 grouping note |
| `ReflectionType`, `ObjectiveType`, `DayStarsType`, `DailyRecapType` | `reflectionsRouter`, `objectivesRouter`, `starsRouter`, `summaryRouter`, `reviewRouter` | `reflections`, `objectives`, `objective_tasks`, `daily_recap` | `services/weekly-review.ts` partial |
| `ScheduledJobType`, `JobRunType` | `jobsRouter` | `scheduled_jobs`, `job_runs` | none — **gate behind an admin scope** |
| `ReminderType`, `PushSubscriptionType` | `notificationsRouter` | `reminders`, `push_subscriptions` | none — extract |
| **Mutations only (not CRUD types):** autoplan / find-slot / instruct | `scheduleRouter`, `planRouter`, `plannerRouter` | — | existing engine fns |
| **Excluded from GraphQL** | `backupRouter`, `oauthRouter`, `syncRouter`, `sseRouter`, `memoryRouter`, `llmRouter`, `healthRouter` | — | file I/O, OAuth redirects, SSE, AI-facing, liveness — don't map to CRUD |

† `PatternType` here is CI-Planner's routine/habit *pattern* entity — unrelated to CI-Server's `type XType` naming. Named `PatternType` (its `XType` form); the pattern *category* (`pattern_types` table) becomes `PatternKindType` to avoid the collision. **Sequencing (Phase Z / W1):** the planned `patterns`→`routines` rename (Z-W1) renames these tables + `/api/patterns`; if W1 lands before this resolver group is authored, name them `RoutineType`/`RoutineKindType` from the start — if this group ships first, W1 renames the GraphQL types with it.

---

## 3. SDL skeleton — Decision 6 `TagType` (the pilot, fully specified)

```graphql
enum TagKind { DIRECTION INTENTION CATEGORY }

type TagType implements Node {
  id: ID!
  label: String!                 # resolver maps DB column `name` → label (column stays `name`)
  description: String            # no column yet — always null until one is added (§5)
  kind: TagKind!                 # additive discriminator; non-breaking for a CI-Server client
  muted: Boolean!                # planner-only (tags.muted), additive
  isBase: Boolean!               # planner-only (tags.is_base), additive

  # Reverse edge to tagged entities (adopted from CI-Server's TagType.entities).
  entities(after: String, before: String, first: Int, last: Int): TaggableEntityConnection!

  # Hierarchy as relationship connections, NOT new top-level types. Which are populated
  # is governed by `kind`: DIRECTION→childIntentions; INTENTION→parentDirections+parentCategories;
  # CATEGORY→childIntentions. Unpopulated edges return an EMPTY connection, never an error.
  parentDirections(after: String, before: String, first: Int, last: Int): TagConnection!
  childIntentions(after: String, before: String, first: Int, last: Int): TagConnection!
  parentCategories(after: String, before: String, first: Int, last: Int): TagConnection!
}

type TagConnection implements Connection {
  edges: [TagEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}
type TagEdge implements Edge { cursor: String!  node: TagType! }

type TaggableEntityConnection implements Connection {
  edges: [TaggableEntityEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}
type TaggableEntityEdge implements Edge { cursor: String!  node: Node! }  # node is Task|TimeBlock

input CreateTagInput { label: String!  kind: TagKind! }
input UpdateTagInput { id: ID!  label: String  muted: Boolean }
input DeleteTagInput { id: ID! }
type CreateTagPayload { tag: TagType   success: Boolean! }
type UpdateTagPayload { tag: TagType   success: Boolean! }
type DeleteTagPayload { deletedId: ID  success: Boolean! }
```

New service work this needs (both cursor-paginated, added to `services/tags.ts`): `TagType.entities` (tag→entities over `entity_tags`) and `childIntentions` (pattern/category→intentions, the reverse of `tag_directions`/`tag_categories`). Everything else maps to existing `services/tags.ts` functions.

---

## 4. SDL skeleton — remaining core entities (field sets abbreviated to the shape)

```graphql
type TaskType implements Node & Taggable {
  id: ID!
  title: String!
  notes: String
  status: TaskStatus!
  priority: Int!
  subtype: TaskSubtype!
  estimatedMinutes: Int
  dueAt: DateTime
  scheduledFor: String            # local YYYY-MM-DD (not an instant) — String, not DateTime
  createdAt: DateTime!
  completedAt: DateTime
  tags: [EntityTagType!]!         # Taggable
  parent: TaskType                # parent_id
  subtasks(after: String, before: String, first: Int, last: Int): TaskConnection!
  dependsOn: [TaskType!]!         # task_dependencies
  objective: ObjectiveType        # first linked objective
  # recurrence: recurrenceRule/recurrenceParentId/occurrenceDate — grouped or flat, TBD in review
}
enum TaskStatus { OPEN DONE RECURRING CANCELLED SKIPPED }   # verified against tasks.status usage
enum TaskSubtype { STANDARD HABIT QUICK }                    # verified (subtype: standard|habit|quick)

type TimeBlockType implements Node & Taggable {
  id: ID!
  title: String!
  blockKind: String!              # task|meeting|habit|focus|break|buffer|timeblock
  startAt: DateTime!
  endAt: DateTime!
  allDay: Boolean!
  isLocked: Boolean!
  isAuto: Boolean!
  status: String!
  task: TaskType                  # task_id
  parentBlock: TimeBlockType      # parent_block_id (Plan container)
  category: TagType               # category_id
  tags: [EntityTagType!]!
  createdAt: DateTime!
}

type PossibleTaskType implements Node {
  id: ID!  rawTitle: String!  status: String!  confidence: Float  createdAt: DateTime!
}
# promotePossibleTask(input): mutation with a side effect (creates a Task) — NOT a field update.

type FlightPlanEntryType implements Node {
  id: ID!  task: TaskType!  selected: Boolean!  position: Int!  sourceKind: String!
}

type SchedulingPrefsType implements Node {
  id: ID!
  # ~39 columns. Proposal: expose logical sub-objects at the API layer (workday{start,end},
  # limits{maxFocusBlockMinutes,minBreakMinutes,…}, planning{horizonDays,recurrenceHorizonDays},
  # models{fast,quality,embed}, memory{…}) even though the DB stays one table — reads far
  # better than a 39-field flat object and costs nothing structurally. Confirm grouping in review.
}

# Objectives / reflections / stars / recap, jobs, notifications, patterns, day types,
# block templates, tag prefs: same XType-implements-Node pattern + XConnection/XEdge +
# Create/Update/Delete Input+Payload. Filled in per-type at implementation.
```

---

## 5. Notes, watch-outs, sequencing

- **Service extraction is the real cost (D3).** `TagType` is the pilot precisely because `services/tags.ts` already exists. `TaskType`/`TimeBlockType`/`prefs`/`flightPlan` have logic **inline in routers** — those need a `services/*.ts` extraction (behaviour-preserving, reused by both REST and GraphQL) *before* their resolvers can be thin. Scope that extraction as its own sub-ticket per resolver group.
- **`scheduledFor` is a local date string, not an instant** — keep it `String`, not `DateTime`, or clients will mis-handle the timezone.
- **`description` on TagType** has no column — always `null` until a driver adds one (optional migration, deferred).
- **`EntityTagType.taggedAt` — RESOLVED (W4a, mig 0110).** Added `entity_tags.created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` by **rebuilding the table** (SQLite forbids a non-constant default on `ADD COLUMN`; `entity_tags` is a leaf — only an outbound FK to `tags`, nothing references it — so the drop/rename is safe inside the migration transaction, guarded by `PRAGMA foreign_key_check`). A per-call-site stamp was rejected: `entity_tags` has **six** insert paths (services/tags.ts + auto-tag / blocks-recur / possibles / recall-clone / groom), and the DB-level default fills `created_at` for all of them — present and future — so `taggedAt: DateTime!` can never serialize null. `level` remains unexposed (planner-internal).
- **Jobs behind a scope** — `ScheduledJobType`/`JobRunType` are admin/internal; gate them, don't expose to a normal owner token.
- **Sequencing with S1/S2** (`S-schema-consolidation.md`): if the `tag_prefs` merge (S2) or `daily_recap` (S1) land first, author `TagPrefType`/`DailyRecapType` against the post-merge shape. As of now migration head is **0104** and those consolidations are their own track.
- **Complexity limiting** — an Apollo plugin bounding query cost before execution (CI-Server's `ComplexityPlugin` analog). **As-built deviation:** implemented directly on `graphql` (one point per selected field, fragments expanded — equivalent to `simpleEstimator({defaultComplexity:1})`) rather than via `graphql-query-complexity`. That library is dual-package (CJS+ESM) and resolves a *second* `graphql` copy in this ESM app, tripping graphql-js's "Duplicate graphql modules" runtime guard; using `graphql` directly guarantees one instance under tsx + vitest. Custom per-field weights (their `fieldExtensionsEstimator`) can be layered later. Every connection field takes cursor args so depth/breadth stays boundable.
- **Auth** — one Apollo context function reads `currentOwnerId()` (from the same `requireAuth` AsyncLocalStorage the REST routes use). No new auth path; works across test/standalone/sso.

---

## 6. Build order

1. **Bootstrap — ✅ DONE (this PR).** Apollo Server 5 + `@as-integrations/koa` mounted at **`/api/graphql`** (under `/api` so `requireAuth` gates it and the resolver context reads the AsyncLocalStorage owner). Base SDL (§1) in `server/src/graphql/schema.graphql` + a `viewer` probe; custom `DateTime`/`JSON` scalars; the complexity plugin (see §5); `buildApp` is now async (`await`s Apollo `start()`). `GRAPHQL_MAX_COMPLEXITY` env (default 1000). Verified over HTTP: `graphql.test.ts` (viewer/auth-context, introspection, complexity reject, 401 when unauthenticated); full server suite green.
2. **TagType pilot (§3) — ✅ DONE.** `TagType implements Node` (id/label/description + additive kind/muted/isBase) with the hierarchy as Relay cursor connections (`parentDirections`/`parentCategories`/`childIntentions`), `tag(id)` + `tags(first,after,kind)` queries, and `createTag`/`updateTag`/`deleteTag` mutations. The CRUD was **extracted** from `routes/tags.ts` into `services/tags.ts` (`createTag`/`updateTag`/`deleteTag`) so REST + GraphQL share ONE implementation (Decision 3) — byte-equivalent REST behavior (adversarially verified). New keyset-paginated reverse-lookups (`pageDirectionChildren`/`pageCategoryChildren`/`pageParentDirections`/`pageParentCategories`/`pageOwnerTags` + counts). SDL in `server/src/graphql/tag.graphql`; the loader now globs all `*.graphql`. `TagType.entities` (tag→Task/TimeBlock) deferred to step 3. **Vocabulary: `kind` = DIRECTION|INTENTION|CATEGORY (Phase Z / W2, PR #239, flipped the enum + underlying `tags.kind` value from the transitional `PATTERN` atomically).** Verified: `graphql-tag.test.ts` (13 tests) + full suite 1219 pass; 3-lens adversarial review 0 findings.
3. **Service extraction + core entities** — `TaskType`, `TimeBlockType` (extract services first), then the rest of the map, one resolver group per PR. Then `TagType.entities` (needs those Taggable types).
4. **W4a — Taggable forward edge — ✅ DONE.** Migration **0110** adds `entity_tags.created_at` by **rebuilding the table** with a DB-level `NOT NULL DEFAULT CURRENT_TIMESTAMP` (see §5) → `schema.ts` `entityTags.createdAt`. `TaskType` + `TimeBlockType` now `implement Node & Taggable`, resolving `tags` via new `entityTagsFull(kind, entityId)` in `services/tags.ts` (all levels, ordered level-then-name). Owner-safe (resolves only on already-owner-scoped rows). Baseline characterization snapshot regenerated (diff = the one new `entity_tags.created_at` column). Tests: `graphql-task.test.ts` + `graphql-timeblock.test.ts` (applied tags come back with a non-null `taggedAt`; untagged → `[]`) + `entity-tags.test.ts` (insert stamps `created_at`, no null rows, `entityTagsFull` shape). Full suite green. **W4b (reverse edge `TagType.entities`) still deferred.**

The base SDL lives at `server/src/graphql/schema.graphql`; per-type SDL alongside it (`tag.graphql`).
