# People on work — Responsible & Beneficiaries

> Design plan for attaching **who does the work** and **who the work is for** to a task
> or time block — two peer people-sets over one shared model — detected automatically
> when an item is suggested, with the colour picker collapsed into a modal to make room.
>
> Status: **implemented** (PR #574), migrations 0151–0153. Written 2026-08-16 against
> `main` @ `91a374e9`; the review-fix notes inline below record where the shipped
> behaviour differs from the first draft of this plan.

---

## 0. Two words that already mean something else

**`tasks.owner_id` exists and means *tenant*, not "person responsible".** `owner ≡ user`
is a locked decision (Phase T #1, 1:1 tenant = user); `owner_id` is the tenancy key every
query filters on, and `possible_tasks.proposed_owner_id` is the same thing (T4,
[schema.ts:116](server/src/db/schema.ts#L116)). Nothing in this feature is named `owner`.

**"User" is overloaded too**, and the feature depends on the distinction:

| Term used here | Means | Lives in |
|---|---|---|
| **Account** | a *permissioned user* — a real login on this install, with a role | `owners` |
| **Person** | anyone in the user's world; may or may not have an account | `people` (new) |
| **Responsible** | the people doing the work | `entity_people.role='responsible'` |
| **Beneficiary** | the people the work is for | `entity_people.role='beneficiary'` |

Every account is a person; most people are not accounts. Accounts are therefore a
convenience — they make a roster available to pre-fill from — never a condition on who
can be named on an item.

---

## 1. Two fields, one model

An item carries **two independent people-sets**, picked through the identical control:

```
RESPONSIBLE    [me] [us] [them]   [Bennett ×] [Chris ×] [+]
BENEFICIARIES  [me] [us] [them]   [Mom ×] [+]
```

This split is what resolves the ambiguity the single me/us/them control carried: "buy
mom a birthday present" is **Responsible = you**, **Beneficiaries = Mom**, and neither
field has to lie about the other.

### The three shortcuts

They are **expansion actions, not stored states** — each one fills the set, and the set
remains freely editable afterwards. This is what makes both fields behave identically.

| Shortcut | Means | Pre-fills with |
|---|---|---|
| **me** | you alone | `{ you }` |
| **us** | you **and** at least one other | `{ you } ∪ { every known account }`, picker open to add more |
| **them** | others, not you | nothing — picker open, you excluded |

**What separates `us` from `them` is whether you are in the set**, not whether the others
hold accounts. Both shortcuts open the same picker, and that picker always offers both
populations: accounts, named people, and type-to-add.

`us` pre-filling with every known account is a convenience on team installs, not the
definition. **With a single sign-on account, `us` still means you + another person** — the
shortcut pins you into the set and opens the picker for the named people who complete it.

Ordering matters for display only: **position 0 of Responsible is the lead** — the one
avatar a card shows when there is room for exactly one. That preserves the original
"task owner" idea without a second mechanism or a cardinality constraint.

### What happens to `motivation`

`tasks.motivation` (`'me' | 'us' | 'them' | NULL`,
[schema.ts:83](server/src/db/schema.ts#L83)) is a shipped Triality axis with its own
scoring, learning, and calibration jobs. It is **not** removed and **not** hand-set any
more — it becomes a **projection of the beneficiary set**, recomputed on every write:

| Beneficiaries | `motivation` |
|---|---|
| `{ you }` only | `me` |
| includes you **and** others | `us` |
| others only, not you | `them` |
| empty | `NULL` |

The axis's core rule survives intact: an **empty** set is `NULL` (never asked), which is
still distinct from `us` (a positive claim of shared benefit). `motivation_source` maps
straight across — user-set beneficiaries ⇒ `'user'`, detected ⇒ `'llm'` — so the existing
"a user value is permanent" guard keeps working untouched.

Because the projection reads the **set** and not the button, it stays correct however the
set was assembled: "me and my wife", where the wife has no login, derives `us` exactly as
a roomful of accounts does. Accounts are a convenience for filling the set, never a
condition on what the axis can express.

The one state the UI must handle is **us** left holding only you, which derives `me`.
That is accurate — nobody else ended up on the item — so the fix belongs in the picker
(stay open until a second person is added), not in the projection.

### Blocks and the "nobody" case

A block with no rows of its own inherits its task's people. "No rows" cannot also mean
"deliberately cleared" — so a **per-role pin** carries that second bit
(`responsible_pinned` / `beneficiaries_pinned`, 0153 → 0154). A pinned role's own set is
authoritative even when empty; without it, removing the last attendee chip wrote an empty
set, the inherit rule fired, and the task's people silently reappeared.

Per ROLE, not per block: the two sets are independent, so stating a meeting's attendees
must not also pin its untouched beneficiary set and quietly end inheritance there.

The write API is therefore three-state, per role:

| Sent | Means |
|---|---|
| absent | leave this role exactly as it is |
| `[]` | **nobody** is on this item for this role (pins) |
| `[ids]` | these people (pins) |
| `null` | resume **inheriting** from the backing task (unpins) |

The `null` arm is what makes a pin reversible — without it a block that once had people
could never track its task again.

Recurring block instances copy their template's people and pins, alongside the tags and
categories they already copied.

### Time blocks

`motivation` is **task-only** today — verified: no reference in
[block.graphql](server/src/graphql/block.graphql) or
[routes/blocks.ts](server/src/routes/blocks.ts), and blocks inherit their linked task's
value ([ElementWizard.tsx:1310-1311](client/src/components/ElementWizard.tsx#L1310)).

Nothing changes there, and no motivation column is added to blocks. Both people-sets live
in `entity_people` keyed by `entity_kind`, so a block carries Responsible and
Beneficiaries natively; the derived `motivation` projection is simply a tasks-only
concern. The awkwardness of an earlier draft — needing a motivation column on blocks —
disappears entirely with the two-field split.

---

## 2. What exists today

Grounding, so the diffs below are real rather than assumed.

**No person entity exists anywhere** — no table, no service, no API. "People" appears in
the codebase only as a passing remark about undated graph nodes
([memory.ts:616](server/src/connectors/memory.ts#L616)).

**The account roster exists but is operator-only.** `GET /api/accounts`
([accounts.ts:104-107](server/src/routes/accounts.ts#L104)) returns every real owner —
behind `requireAdmin`, and returning `email`, `role`, and `hasPassword`. The **us**
shortcut needs a roster any authenticated user can read, so this endpoint **must not be
loosened**; add a separate minimal one (§4).

**Calendar attendees are typed but never populated.** `CalendarEvent.attendees?: string[]`
is declared at [google.ts:26](server/src/mcp/google.ts#L26) and nothing fills it. Broken
in three places:

| Layer | File | State |
|---|---|---|
| MCP handler → Google REST | [mcp/google-server.ts:54-65](server/src/mcp/google-server.ts#L54) | maps `summary`→`title` only; no attendees, organizer, or description |
| MCP client → `RemoteEvent` | [connectors/base.ts:7-20](server/src/connectors/base.ts#L7) | no attendee field on the type |
| Live client → `CalendarEvent` | [google.ts:159-166](server/src/mcp/google.ts#L159) | maps id/title/start/end; hardcodes `description: ''` |

**Gmail carries `from` and is the only review-gated source.** Ingest stashes
`{ from, subject }` into `possible_tasks.source_payload`
([ingest.ts:368-370](server/src/agents/ingest.ts#L368)). Email possibles wait for
approval; gcal/text/memory auto-promote
([review-gate.ts:22](server/src/services/review-gate.ts#L22)). Gmail is off by default on
most installs — `gmail.readonly` is a Google *restricted* scope.

**The colour control is the `TEXTURE` section**
([ElementWizard.tsx:1334-1364](client/src/components/ElementWizard.tsx#L1334)): On/Off
pill, Auto pill, and a 14-swatch grid wrapping to **three rows** in the 290px left pane,
directly under "Who is this for?". Verified in the running app.

---

## 3. Data model

Migration `0151_people` (SQLite is at `0150`).

### `people` — the per-tenant directory

```
id           TEXT PK (uuid7)
owner_id     TEXT NOT NULL FK owners(id) ON DELETE CASCADE  -- TENANCY: whose directory
account_id   TEXT     NULL FK owners(id) ON DELETE SET NULL -- the ACCOUNT this person is, if any
display_name TEXT NOT NULL
confirmed    INTEGER NOT NULL DEFAULT 1   -- 0 = provisionally created by ingest
source       TEXT                          -- 'manual' | 'account' | 'gcal' | 'gmail' | 'llm'
notes        TEXT
created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

⚠️ **`owner_id` and `account_id` both FK `owners(id)` and mean completely different
things.** `owner_id` is tenancy, as in every other table; `account_id` is *which
permissioned user this person is*. Document this on the table — it is the single most
misreadable line in the design.

- `account_id IS NOT NULL` ⇒ appears in the roster **us** pre-fills from, and is the only
  case that creates a cross-tenant reference (§4). Both shortcuts can still reach either
  population.
- `account_id = owner_id` ⇒ the user's own row, so `is_self` is derived, not stored.
- `UNIQUE(owner_id, display_name)` mirrors `tags`' per-owner uniqueness
  ([schema.ts:345](server/src/db/schema.ts#L345)); `UNIQUE(owner_id, account_id)` keeps
  one row per account per directory.

### `person_emails` — the matching key

```
owner_id   TEXT NOT NULL FK owners(id) ON DELETE CASCADE
person_id  TEXT NOT NULL FK people(id) ON DELETE CASCADE
email      TEXT NOT NULL                  -- stored lowercased
PRIMARY KEY (owner_id, email)
```

Owner-scoped uniqueness, not global — the same address may be two people across two
tenants. This turns a Gmail `From:` or a calendar attendee into a `person_id` with no
model in the loop.

### `entity_people` — both sets, for tasks *and* blocks

```
entity_kind  TEXT NOT NULL      -- 'task' | 'time_block'
entity_id    TEXT NOT NULL      -- no FK; spans tables, app-enforced
person_id    TEXT NOT NULL FK people(id) ON DELETE CASCADE
role         TEXT NOT NULL      -- 'responsible' | 'beneficiary'
source       TEXT               -- 'user' | 'llm' | 'calendar' | 'email'
position     INTEGER NOT NULL DEFAULT 0   -- 0 in 'responsible' = the lead
created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
PRIMARY KEY (entity_kind, entity_id, person_id, role)
```

A structural mirror of `entity_categories`
([schema.ts:535](server/src/db/schema.ts#L535)) — same entity-spanning idiom, same
no-FK-on-`entity_id` rule, same `position`, same created_at default. `role` is in the
primary key because **the same person legitimately appears in both sets** (you are
usually both responsible for and a beneficiary of your own work), which is precisely why
the two fields need one table and one model rather than two shapes.

No cardinality constraint on either set: both are plain multi-selects, and "the lead" is
`position = 0`, not a schema rule.

Indexes: `ix_entity_people_person(person_id)`,
`ix_entity_people_entity(entity_kind, entity_id, role)`.

### `possible_task_people` — carrying detection through promotion

Migration `0152`, following `possible_task_tags`
([schema.ts:547](server/src/db/schema.ts#L547)):

```
possible_task_people(possible_task_id, person_id, role, source, confidence)
```

### Schema bookkeeping

- Mirror all four tables in [`db/schema.ts`](server/src/db/schema.ts) — the drift checker
  already reports 16 tables missing from it; do not make it 20.
- Values enforced in code, not `CHECK` constraints (repo convention, stated in
  [0141](server/src/db/migrations/0141_task_motivation.ts)).
- Append to `MIGRATIONS` in [migrations/index.ts](server/src/db/migrations/index.ts).
- **Postgres parity is open** — `server/db/postgres/migrations/` stops at a 2026-08-02
  baseline while SQLite is at 0150, so that path already lags.

---

## 4. Tenancy — the load-bearing decision

Naming an **account** on an item — from either shortcut, in either field — is the first
place this app lets one tenant's row reference another tenant's user. Naming a person who
has no account raises none of this. Two readings, and they are very different systems:

**(a) Reference-only — recommended for phase 1.** The account is a label on your item. It
does not appear in their planner, does not affect their capacity, and they are never
notified. Owner-scoping is unchanged; `entity_people` rows stay inside the tenant that
created them. This is what "us = the team" most plainly means, and it is safe.

**(b) Real sharing.** The item becomes visible to the referenced accounts. That is a
genuine multi-tenant feature — cross-tenant reads, a permission model, notification, and
an answer for what happens when they edit or complete it. It is a phase of its own, not a
field.

The plan below builds (a). If (b) is the goal, say so before step 1 — it changes the data
model, not just the UI.

**The roster endpoint.** `GET /api/accounts` is operator-only and returns email + role +
`hasPassword`; do not relax it. Add `GET /api/people/accounts` — any authenticated
session, returning `{ id, name }` only, sentinel excluded (as `listOwners` already does).
A member filling a people field should not thereby learn everyone's email address and
role. On a single-account install it simply returns just them, and the picker falls back
to named people — the field stays fully usable.

---

## 5. Detection — deterministic first, model second

Carried over from `motivation`: **facts before guesses; unsure ⇒ empty, never a
fabricated name.**

The two fields detect very differently, and that asymmetry is the important part:

- **Responsible is observable.** Calendar attendees and email correspondents are facts on
  the record. Deterministic resolution, no model.
- **Beneficiaries are a judgment.** Nothing in an invite says who the work is *for*. This
  is where the LLM earns its place — and it is the question
  [services/motivation.ts](server/src/services/motivation.ts) already answers today.

### 5a. Prerequisite: plumb calendar attendees

Nothing about Responsible detection from calendar works until this lands. Four mechanical
edits:

1. [mcp/google-server.ts:54-65](server/src/mcp/google-server.ts#L54) — map
   `attendees[].email`, `organizer.email`, and `description` onto the tool response.
2. [connectors/base.ts:7](server/src/connectors/base.ts#L7) — add `attendees?`,
   `organizer?`, `description?` to `RemoteEvent`.
3. `toRemoteEvent` in [mcp/client.ts](server/src/mcp/client.ts) — pass them through.
4. [mcp/google.ts:159-166](server/src/mcp/google.ts#L159) — populate
   `CalendarEvent.attendees`; stop hardcoding `description: ''`.

Step 4's description fix is a free win: gcal extraction currently only ever sees the event
*title*.

### 5b. Responsible — deterministic

| Source | Addresses |
|---|---|
| `gcal` | `event.organizer` + `event.attendees[]` |
| `gmail` | `From:` (already in `source_payload`), plus `To:`/`Cc:` once plumbed |
| `text` | none |

Resolve each against `person_emails` (owner-scoped). You are always included — it is your
planner. If the calendar organizer resolves to someone other than you, they take
`position = 0` (the lead); otherwise you do. That is a fact from the invite, not a guess.

### 5c. Beneficiaries — the model's job

Reuse the shipped classifier rather than writing a second one:
`classifyMotivationLLM` already returns `me | us | them | null`, and its keyword fallback
already runs inline when Ollama is down. Map its answer through the §1 shortcuts:

| Classifier says | Seeds Beneficiaries with |
|---|---|
| `me` | `{ you }` |
| `us` | `{ you } ∪ { accounts }` — the same expansion the UI button performs |
| `them` | the named people the item mentions, resolved; **empty if none resolve** |
| `null` | empty — unlabeled, which is the honest answer |

For `them` with no resolvable person, the model may propose *names* as free strings —
those surface as "create person?" chips on the suggestion, never as silent directory
writes.

Extend `ExtractedTask` ([extract.ts:19-30](server/src/agents/extract.ts#L19)) with
`responsibleHints?: string[]` and `beneficiaryHints?: string[]`, normalized in
`normalize()` with the same defensive clamping the existing fields get.

New `server/src/services/people.ts` owns resolve, match, create-provisional, attach, the
**us** expansion, and the `motivation` projection — mirroring how `services/motivation.ts`
owns its axis today.

### 5d. Unresolved addresses

- **Do not** create person rows while scanning. Ingest reads far more mail and events than
  the user ever promotes; auto-creating there turns the directory into a mailing-list dump
  within a week.
- Stash unresolved addresses on `possible_tasks.source_payload` (already JSON).
- Create the `people` row **at promotion**, `confirmed = 0`, `source = 'gcal'|'gmail'`, so
  the directory grows only with items the user accepted. Settings → People surfaces
  unconfirmed rows for merge, rename, or delete.

### 5e. Provenance

`entity_people.source` is the `motivation_source` analogue with the same guarantee: **a
user-set assignment is permanent and no machine pass overwrites it.** Enforce it in SQL as
`motivation` does — a guarded `UPDATE ... WHERE source != 'user'` — so no caller ordering
can violate it.

---

## 6. API surface

Both transports, since REST and GraphQL share one owner-scoped service implementation
(Decision 3, restated at [possibles.ts:14](server/src/services/possibles.ts#L14)).

**REST** — new `server/src/routes/people.ts`: `GET/POST/PATCH/DELETE /api/people`,
`POST /api/people/:id/merge`, and the minimal `GET /api/people/accounts` roster from §4.
Register in [routes/index.ts](server/src/routes/index.ts).

**Task & block payloads** — add `responsible` and `beneficiaries` to the serialized shape
([lib/serialize.ts](server/src/lib/serialize.ts)); accept `responsible_ids` and
`beneficiary_ids` on create/update in [services/tasks.ts](server/src/services/tasks.ts)
and the blocks service, with the `motivation` projection applied server-side on every
beneficiary write. Strip `source` from client bodies exactly as the route strips
`motivation_source` ([tasks.ts:145-148](server/src/services/tasks.ts#L145)) — a client may
set a value, never claim provenance.

**GraphQL** — new `people.graphql` + `people-resolvers.ts`; add
`responsible: [Person!]!` and `beneficiaries: [Person!]!` to `Task` and `TimeBlock`.
Register in [graphql/index.ts](server/src/graphql/index.ts) and cost the new list fields
in [complexity.ts](server/src/graphql/complexity.ts).

**Promotion** — add `carryPossiblePeople()` beside `carryPossibleTags()`
([possibles.ts:64-71](server/src/services/possibles.ts#L64)), called from the same place
so REST and GraphQL promote identically, carrying both roles.

**SSE** — broadcast people changes on the existing channel
([routes/sse.ts](server/src/routes/sse.ts)).

**Backup/export** — add the new tables to [routes/backup.ts](server/src/routes/backup.ts),
scoped by `owner_id`, or a restore silently drops every assignment.

---

## 7. UI

### 7a. Collapse `TEXTURE` into a modal

Replace the three-row swatch grid with a **single trigger pill** — `Texture · [●]`,
showing on/off state and a dot in the current colour — opening a small modal with the same
controls plus Done. Reuse the
[`ObjectiveModal`](client/src/components/ObjectiveModal.tsx) shell, and the existing
[`ItemColorPicker`](client/src/components/ItemColorPicker.tsx) for the grid rather than
keeping the inline copy — that component is already used by three other screens, so this
also deletes a duplicate.

No state changes: the `textureEnabled()` / `textureColorToken()` signals and the
`doSave()` payload
([ElementWizard.tsx:845-846](client/src/components/ElementWizard.tsx#L845)) are untouched.

### 7b. The reclaimed space — and it comes out even

```
RESPONSIBLE     [me] [us] [them]   [Bennett ×] [+]
BENEFICIARIES   [me] [us] [them]   [Mom ×] [+]
TEXTURE         [On ●]
```

The space math, in 290px-pane rows:

| | Before | After |
|---|---|---|
| Who is this for? / Beneficiaries | 2 | 2 |
| Responsible | — | 2 |
| Texture | 4 (label + 3 wrapped swatch rows) | 2 |
| **Total** | **6** | **6** |

The wizard gains a whole second people field and does not grow — the swatch grid pays for
it exactly. (The pane is `max-h-[68vh] overflow-y-auto`, so this is a quality goal rather
than a hard limit, but a neutral result is worth having.)

Behaviour, identical for both fields:

- One shared `PeopleField` component, twice. Same picker, same chips, same typeahead —
  which is what "the same model" buys.
- Tapping a shortcut **fills** the set; chips stay individually removable afterwards.
- The typeahead's last row is always "Create *name*", POSTing to `/api/people` with
  `source='manual'`, `confirmed=1`.
- **us** is always available, single sign-on account or not (§1): it pins you into the set
  and opens the picker, which reaches accounts and named people alike. It stays open until
  a second person is on the item, so `us` never quietly resolves to `me`.
- A detected set renders the same `(suggested)` hint the motivation control already uses
  ([ElementWizard.tsx:1315-1317](client/src/components/ElementWizard.tsx#L1315)) and only
  sends on touch — same `motivationTouched()` idiom, now per field.
- Both fields appear on the **Time Block** tab too, unchanged (§1).
- Extend `ElementForm` ([element.ts:159-182](client/src/lib/element.ts#L159)) with
  `responsibleIds` / `beneficiaryIds` and thread through `saveElement`. The existing
  `motivation` form field is **removed** — the server derives it.

### 7c. Everywhere else

| Surface | Change |
|---|---|
| [SuggestionsSection.tsx:88-105](client/src/components/SuggestionsSection.tsx#L88) | show detected Responsible/Beneficiaries in the meta line **before** approval — the whole point of detecting at suggestion time |
| [DetailsDrawer.tsx](client/src/components/DetailsDrawer.tsx) | both sets as read-only chip rows, on tasks **and** blocks (editing stays in the wizard) |
| [TaskCard.tsx](client/src/components/TaskCard.tsx) / [BlockCard.tsx](client/src/components/BlockCard.tsx) | compact initials cluster for Responsible (lead first), no names |
| [Settings.tsx](client/src/views/Settings.tsx) | new **People** panel: list, rename, merge, delete, review unconfirmed |
| [AllTasks.tsx](client/src/views/AllTasks.tsx) | filter by person **and by role** — "what am I on the hook for" vs "what I'm doing for Mom" are different questions |

---

## 8. Out of scope — but note the coupling

**Pushing Responsible to Google Calendar as attendees.** `RemoteEventInput`
([connectors/base.ts:22](server/src/connectors/base.ts#L22)) has no attendee field, and
adding one makes the app *send invitations to real people* — a different blast radius from
reading them. Its own change, behind `CP_SYNC_WRITEBACK`, with an explicit confirm.

**Delegation semantics.** A Responsible set that does not include you still does not mean
anything to the scheduler — it does not exclude the task from Auto placement, capacity, or
Balance metrics. A design conversation, not plumbing; flagged so nobody assumes it falls
out free.

**Triality re-calibration.** `motivation` becoming derived changes *how often* it is set —
today it is frequently NULL, and a beneficiary picker will fill it far more often. The
calibration job ([0143](server/src/db/migrations/0143_calibrate_triality_job.ts)) should
be re-run and the weights sanity-checked after rollout, or the axis silently shifts
meaning under the existing thresholds.

---

## 9. Sequenced worklist

| # | Step | Files |
|---|---|---|
| 1 | Migrations `0151_people`, `0152_possible_task_people` + `schema.ts` mirrors + registration | `db/migrations/`, `db/schema.ts` |
| 2 | `services/people.ts` — resolve / match / create-provisional / attach / **us** expansion / `motivation` projection | new |
| 3 | REST `routes/people.ts` incl. minimal accounts roster; task/block payload fields; serialize | `routes/`, `services/tasks.ts`, `lib/serialize.ts` |
| 4 | GraphQL `people.graphql` + resolvers + `Task`/`TimeBlock` fields + complexity | `graphql/` |
| 5 | Backup/export coverage | `routes/backup.ts` |
| 6 | Plumb calendar attendees end-to-end (§5a) | `mcp/google-server.ts`, `connectors/base.ts`, `mcp/client.ts`, `mcp/google.ts` |
| 7 | Detection both roles + `possible_task_people` + `carryPossiblePeople` | `agents/extract.ts`, `agents/ingest.ts`, `services/possibles.ts` |
| 8 | Collapse Texture → modal (§7a) | `ElementWizard.tsx`, reuse `ItemColorPicker` |
| 9 | `PeopleField` ×2 + `ElementForm` threading; drop the client-side `motivation` field (§7b) | `ElementWizard.tsx`, `lib/element.ts` |
| 10 | Suggestions / drawer / cards / Settings / filters (§7c) | various |

Steps 1–5 ship manual assignment on their own. 6–7 add the automatic half. 8–10 are the
UI. **6 precedes 7**, and **8 precedes 9** (9 needs the space 8 frees).

Tests, `.test.ts(x)` beside each unit per repo convention. The ones that carry weight: the
`motivation` projection across all four cases (especially empty ⇒ NULL, not `us`), the
`source='user'` always-wins guard, email→person resolution being owner-scoped (a
cross-tenant address must not match), **us** reaching named people on a single-account
install, the same person occupying both roles, and promotion carrying both sets across.

---

## 10. Decisions needed before step 1

1. **Tenancy (§4)** — reference-only, or real cross-tenant sharing? Changes the data
   model, not just the UI.
2. **Account pre-fill (§1)** — should **us** pre-select every known account (planned), or
   open empty with just you pinned? Pre-filling is one tap to prune on a small team and
   several on a large one.
3. **Provisional people (§5d)** — create at promotion with `confirmed=0`, or keep the
   directory strictly manual?
4. **Attendee storage** — acceptable for the local DB to accumulate other people's email
   addresses from calendar invites?
5. **Postgres parity** — add `dbmate` counterparts for 0151/0152, or ride the existing lag?
