# People on work — Responsible & Beneficiaries

> Design plan for attaching **who does the work** and **who the work is for** to a task
> or time block — two peer people-sets over one shared model — detected automatically
> when an item is suggested, with the colour picker collapsed into a modal to make room.
>
> Status: **implemented** (PR #574), migrations 0151–0154 (`0151_people`,
> `0152_possible_task_people`, and the per-role block pins `0153`/`0154`). Written
> 2026-08-16 against `main` @ `91a374e9`; the review-fix notes inline below record where the
> shipped behaviour differs from the first draft of this plan. File links point at the code
> as of `3cfbbdf2` (2026-11-01); §2 describes the code as it was when the plan was written.

---

## 0. Two words that already mean something else

**`tasks.owner_id` exists and means *tenant*, not "person responsible".** `owner ≡ user`
is a locked decision (Phase T #1, 1:1 tenant = user); `owner_id` is the tenancy key every
query filters on, and `possible_tasks.proposed_owner_id` is the same thing (T4,
[schema.ts:119](../server/src/db/schema.ts#L119)). Nothing in this feature is named `owner`.

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
[schema.ts:86](../server/src/db/schema.ts#L86)) is a shipped Triality axis with its own
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
could never track its task again. It is reachable from the UI as **"Use task's"**, shown
on a task-backed block once it has an override to give up; an API that can express it is
not the same as a user being able to do it.

An inheriting field renders differently from an empty one — "Following the linked task"
plus the task's people, italicised, and an **Override** button — because collapsing those
two states back into one empty field would undo exactly what the pin exists to separate.
Which state a block is in is reported by the server (`responsible_inherited` /
`beneficiaries_inherited`), not inferred client-side: an empty set means "nobody" when
pinned and "inherit" when not, and the client cannot tell those apart.

Recurring instances take the template's people at materialisation and keep them —
copy-on-create, exactly like tags and categories. **Known limitation:** editing a
recurring meeting's attendees reaches occurrences not yet rendered, not ones that already
exist. A re-sync pass was tried and reverted: an instance created with people never
matched its "no people of its own" guard, so it was inert while still costing a query per
template on every planner read. Doing it properly means driving propagation from the
template WRITE and deciding what happens to customised occurrences — tracked separately.

Recurring block instances copy their template's people and pins, alongside the tags and
categories they already copied.

### Time blocks

`motivation` is **task-only** — verified: no reference in
[block.graphql](../server/src/graphql/block.graphql) or
[routes/blocks.ts](../server/src/routes/blocks.ts).

Nothing changes there, and no motivation column is added to blocks. Both people-sets live
in `entity_people` keyed by `entity_kind`, so a block carries Responsible and
Beneficiaries natively; the derived `motivation` projection is simply a tasks-only
concern. The awkwardness of an earlier draft — needing a motivation column on blocks —
disappears entirely with the two-field split.

---

## 2. What existed before

Grounding, as of the commit this plan was written against (`91a374e9`), so the diffs below
were real rather than assumed. A **Now** line says where the implementation has since closed
the gap.

**No person entity existed** — no table, no service, no API. "People" appeared in the
codebase only as a passing remark about undated graph nodes (still at
[memory.ts:625](../server/src/connectors/memory.ts#L625)). **Now:** `people`,
`person_emails`, `entity_people` and `possible_task_people`
([schema.ts:587-640](../server/src/db/schema.ts#L587)), `services/people.ts`,
`routes/people.ts` and `people.graphql`.

**The account roster exists but is operator-only.** `GET /api/accounts`
([accounts.ts:105-108](../server/src/routes/accounts.ts#L105)) returns every real owner —
behind `requireAdmin`, and returning `email`, `role`, and `hasPassword`. The **us**
shortcut needs a roster any authenticated user can read, so this endpoint **must not be
loosened**; add a separate minimal one (§4). **Now:** `GET /api/people/accounts`
([routes/people.ts:36](../server/src/routes/people.ts#L36)).

**Calendar attendees were typed but never populated.** `CalendarEvent.attendees?: string[]`
was declared in [mcp/google.ts](../server/src/mcp/google.ts) and nothing filled it. Broken
in three places:

| Layer | File | State then |
|---|---|---|
| MCP handler → Google REST | `mcp/google-server.ts` | mapped `summary`→`title` only; no attendees, organizer, or description |
| MCP client → `RemoteEvent` | `connectors/base.ts` | no attendee field on the type |
| Live client → `CalendarEvent` | `mcp/google.ts` | mapped id/title/start/end; hardcoded `description: ''` |

**Now:** all three carry them —
[`mapGoogleEvent`](../server/src/mcp/google-server.ts#L65),
[`RemoteEvent.attendees` / `organizer` / `description`](../server/src/connectors/base.ts#L21),
and the live `listEvents` mapping ([google.ts:168-182](../server/src/mcp/google.ts#L168)).

**Gmail carries `from` and is the only review-gated source.** Ingest stashes
`{ from, subject }` into `possible_tasks.source_payload`
([ingest.ts:566](../server/src/agents/ingest.ts#L566)). Email possibles wait for
approval; gcal/text/memory auto-promote
([review-gate.ts:22](../server/src/services/review-gate.ts#L22)). Gmail is off by default on
most installs — `gmail.readonly` is a Google *restricted* scope.

**The colour control was the `TEXTURE` section** of `ElementWizard.tsx`: On/Off
pill, Auto pill, and a 14-swatch grid wrapping to **three rows** in the 290px left pane,
directly under "Who is this for?". **Now:** a trigger pill that opens
[`TextureModal`](../client/src/components/TextureModal.tsx) (§7a).

---

## 3. Data model

Migration `0151_people` (SQLite was at `0150` when this was written).

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
  ([schema.ts:366](../server/src/db/schema.ts#L366)); `UNIQUE(owner_id, account_id)` keeps
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
([schema.ts:559](../server/src/db/schema.ts#L559)) — same entity-spanning idiom, same
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
([schema.ts:571](../server/src/db/schema.ts#L571)):

```
possible_task_people(possible_task_id, person_id, role, source, confidence)
```

### Schema bookkeeping

- Mirror all four tables in [`db/schema.ts`](../server/src/db/schema.ts) — the drift checker
  (`pnpm --filter server db:check-drift`) already reported 16 tables missing from it; do not
  make it 20. Shipped: all four are mirrored ([schema.ts:587-640](../server/src/db/schema.ts#L587)).
- Values enforced in code, not `CHECK` constraints (repo convention, stated in
  [0141](../server/src/db/migrations/0141_task_motivation.ts)).
- Append to `MIGRATIONS` in [migrations/index.ts](../server/src/db/migrations/index.ts).
- **Postgres parity is open** — `server/db/postgres/migrations/` stops at a 2026-08-02
  baseline (`20260802000400_create_planning_baseline.sql`) while SQLite was at 0150 when
  this was written (it is at 0172 now), so that path already lagged and still does.

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
(As shipped the entry is `{ account_id, name, person_id }`, `person_id` being the directory row
if one already exists; still no email or role.)
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
  [services/motivation.ts](../server/src/services/motivation.ts) already answers today.

### 5a. Prerequisite: plumb calendar attendees

Nothing about Responsible detection from calendar works until this lands. Four mechanical
edits:

1. [mcp/google-server.ts:65-91](../server/src/mcp/google-server.ts#L65) (`mapGoogleEvent`) — map
   `attendees[].email`, `organizer.email`, and `description` onto the tool response.
2. [connectors/base.ts:7](../server/src/connectors/base.ts#L7) — add `attendees?`,
   `organizer?`, `description?` to `RemoteEvent`.
3. `toRemoteEvent` in [mcp/client.ts](../server/src/mcp/client.ts) — pass them through.
4. [mcp/google.ts:168-182](../server/src/mcp/google.ts#L168) — populate
   `CalendarEvent.attendees`; stop hardcoding `description: ''`.

Step 4's description fix is a free win: gcal extraction used to see only the event
*title*. All four edits shipped as written.

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

Extend `ExtractedTask` ([extract.ts:18-29](../server/src/agents/extract.ts#L18)) with
`responsibleHints?: string[]` and `beneficiaryHints?: string[]`, normalized in
`normalize()` with the same defensive clamping the existing fields get.

> **As shipped, §5c was not built this way.** Ingest attaches only the *responsible* set
> ([ingest.ts:230-240](../server/src/agents/ingest.ts#L230)); beneficiaries are not seeded
> from the classifier, because expanding `us` to `{ you }` on a single-account install would
> project straight back to `me` and silently downgrade the label. `ExtractedTask` has no
> `responsibleHints` / `beneficiaryHints`: addresses ingest cannot resolve ride on
> `source_payload.people_hints` and become `confirmed = 0` people at promotion
> ([possibles.ts:78-90](../server/src/services/possibles.ts#L78)).

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
(Decision 3, restated at [possibles.ts:19](../server/src/services/possibles.ts#L19)).

**REST** — new `server/src/routes/people.ts`: `GET/POST/PATCH/DELETE /api/people`,
`POST /api/people/:id/merge`, and the minimal `GET /api/people/accounts` roster from §4.
Register in [routes/index.ts](../server/src/routes/index.ts). As shipped, there is also
`GET /api/people/:id` and `POST /api/people/accounts/:id` (find-or-create the directory row
for an account when it is picked off the roster).

**Task & block payloads** — add `responsible` and `beneficiaries` to the serialized shape
([lib/serialize.ts](../server/src/lib/serialize.ts)); accept `responsible_ids` and
`beneficiary_ids` on create/update in [services/tasks.ts](../server/src/services/tasks.ts)
and the blocks service, with the `motivation` projection applied server-side on every
beneficiary write. Strip `source` from client bodies exactly as the route strips
`motivation_source` ([tasks.ts:145-148](../server/src/services/tasks.ts#L145)) — a client may
set a value, never claim provenance.

**GraphQL** — new `people.graphql` + `people-resolvers.ts`; add
`responsible: [PersonType!]!` and `beneficiaries: [PersonType!]!` to `Task` and `TimeBlock`.
Register in [graphql/resolvers.ts](../server/src/graphql/resolvers.ts) (as shipped; the
plan said `graphql/index.ts`) and cost the new list fields in
[complexity.ts](../server/src/graphql/complexity.ts).

**Promotion** — add `carryPossiblePeople()` beside `carryPossibleTags()`
([possibles.ts:71](../server/src/services/possibles.ts#L71); `carryPossiblePeople` is at
[possibles.ts:90](../server/src/services/possibles.ts#L90)), called from the same place
so REST and GraphQL promote identically, carrying both roles.

**SSE** — broadcast people changes on the existing channel
([routes/sse.ts](../server/src/routes/sse.ts)).

**Backup/export** — add the new tables to [routes/backup.ts](../server/src/routes/backup.ts),
scoped by `owner_id`, or a restore silently drops every assignment.

---

## 7. UI

### 7a. Collapse `TEXTURE` into a modal

Replace the three-row swatch grid with a **single trigger pill** — `Texture · [●]`,
showing on/off state and a dot in the current colour — opening a small modal with the same
controls plus Done. Reuse the
[`ObjectiveModal`](../client/src/components/ObjectiveModal.tsx) shell, and the existing
[`ItemColorPicker`](../client/src/components/ItemColorPicker.tsx) for the grid rather than
keeping the inline copy — that component is already used by three other screens, so this
also deletes a duplicate. As shipped: `TextureTrigger` and `TextureModal` in
[TextureModal.tsx](../client/src/components/TextureModal.tsx), which uses `ItemColorPicker`.

No state changes: the `textureEnabled()` / `textureColorToken()` signals and the
`doSave()` payload
([ElementWizard.tsx:903-904](../client/src/components/ElementWizard.tsx#L903)) are untouched.

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
- A detected set renders a `(suggested)` hint
  ([PeopleField.tsx:184](../client/src/components/PeopleField.tsx#L184)) and only
  sends on touch — the `motivationTouched()` idiom, now per field (`responsibleTouched` /
  `beneficiariesTouched`).
- Both fields appear on the **Time Block** tab too, unchanged (§1).
- Extend `ElementForm` ([element.ts:159](../client/src/lib/element.ts#L159)) with
  `responsibleIds` / `beneficiaryIds` and thread through `saveElement`. The existing
  `motivation` form field is **removed** — the server derives it. (As shipped, the wizard
  has no motivation control any more, but `ElementForm.motivation` was kept for quick-add's
  overlay, which still sets it directly; see [element.ts:182](../client/src/lib/element.ts#L182).)

### 7c. Everywhere else

| Surface | Change |
|---|---|
| [SuggestionsSection.tsx:92-124](../client/src/components/SuggestionsSection.tsx#L92) | show detected Responsible/Beneficiaries in the meta line **before** approval — the whole point of detecting at suggestion time (shipped for Responsible only: ingest detects only that set) |
| [DetailsDrawer.tsx](../client/src/components/DetailsDrawer.tsx) | both sets as read-only chip rows, on tasks **and** blocks (editing stays in the wizard) |
| [TaskCard.tsx](../client/src/components/TaskCard.tsx) / [BlockCard.tsx](../client/src/components/BlockCard.tsx) | compact initials cluster for Responsible (lead first), no names (shipped on `TaskCard.tsx` and the Planner's [`PlannerEntityCard.tsx`](../client/src/components/PlannerEntityCard.tsx); `BlockCard.tsx` has none) |
| [Settings.tsx](../client/src/views/Settings.tsx) | new **People** panel: list, rename, merge, delete, review unconfirmed |
| [AllTasks.tsx](../client/src/views/AllTasks.tsx) | filter by person **and by role** — "what am I on the hook for" vs "what I'm doing for Mom" are different questions (**not built**: `AllTasks.tsx` has no person filter) |

---

## 8. Out of scope — but note the coupling

**Pushing Responsible to Google Calendar as attendees.** `RemoteEventInput`
([connectors/base.ts:34](../server/src/connectors/base.ts#L34)) has no attendee field, and
adding one makes the app *send invitations to real people* — a different blast radius from
reading them. Its own change, behind `CP_SYNC_WRITEBACK`, with an explicit confirm.

**Delegation semantics.** A Responsible set that does not include you still does not mean
anything to the scheduler — it does not exclude the task from Auto placement, capacity, or
Balance metrics. A design conversation, not plumbing; flagged so nobody assumes it falls
out free.

**Triality re-calibration.** `motivation` becoming derived changes *how often* it is set —
today it is frequently NULL, and a beneficiary picker will fill it far more often. The
calibration job ([0143](../server/src/db/migrations/0143_calibrate_triality_job.ts)) should
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

As shipped (PR #574 and its review rounds): all ten steps landed except that step 7 detects
the Responsible set only (§5c), step 9 kept `ElementForm.motivation` for quick-add, and
step 10's person/role filter on `AllTasks.tsx` was not built. The per-role block pins
(`0153`, then `0154`) came after the plan.

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
