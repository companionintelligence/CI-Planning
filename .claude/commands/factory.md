---
description: Turn a feature idea into commit-recipe Factory tickets and create them as GitHub issues.
argument-hint: [rough feature idea]
allowed-tools: Bash(scripts/factory/factory.sh:*), Bash(gh:*), Bash(git:*), Bash(grep:*), Bash(find:*), Read, Write
---

You are running the **Factory ticket workflow**. Turn a rough feature idea into a set
of small, atomic, testable tickets — each written like a **git commit recipe** an LLM
can execute without guessing — then create them as GitHub issues on the **Factory**
project board.

The feature idea (may be empty): **$ARGUMENTS**

Guiding principle: a ticket should *reduce interpretation*. Exact files, exact schema,
exact constraints, exact verification commands. If a section could be read two ways,
tighten it. Do not skip the approval gates.

## Phase 1 — Frame the idea

If `$ARGUMENTS` is empty, ask the user for the feature idea in one sentence and wait.

Read repo context so tickets are grounded in reality: `ARCHITECTURE.md`, `README.md`,
relevant `docs/`, and the actual code areas the idea would touch.

## Phase 2 — Interview (one focused batch)

Ask a **single batch** of 3–6 tailored questions covering the gaps that would otherwise
make tickets vague: scope & non-goals; data/schema; user-facing surface; edge cases &
constraints (scale, local-first/offline, Ollama, permissions); dependencies & sequencing;
rough ticket count. Wait for answers; at most one short follow-up batch.

## Phase 3 — Propose the breakdown (APPROVAL GATE)

Present a numbered list: each ticket's **title** + one-line **goal** + **type**. Prefer
several small, independently-mergeable tickets over one big one. Note ordering / `blocked by`.
Get explicit approval before proceeding.

## Phase 4 — Pin conventions (inspect before drafting)

For each area a ticket touches, **read the real code and pin exact conventions** — never
write "match existing convention" without stating what it is. Typical pins for this repo:

- **DB migrations:** read `server/src/db/migrations/` (latest slot, `id`/`up` shape,
  idempotent `IF NOT EXISTS`, forward-only, `manual` only for FK-toggling rebuilds),
  `migrations/index.ts` (registration), `migrate.ts` (runner/idempotency).
- **Schema style:** `server/src/db/schema.ts` — `id()`/`createdAt()` helpers, TEXT UUIDv7
  via `newId`, `owner_id … REFERENCES owners(id)` (no on-delete), ISO-8601 TEXT timestamps,
  **status enums are TEXT enforced in code, NOT `CHECK` constraints**, FK on-delete
  (`cascade` for business parents, `set null` for optional refs), inline `UNIQUE(...)`,
  `ix_<table>_<cols>` indexes by real access patterns (not redundant with a UNIQUE prefix).
- Match these exactly in the ticket so the working model has nothing to invent.

## Phase 5 — Draft full ticket bodies

For each approved ticket, write a body with this **full-recipe structure** (mirror
`.github/ISSUE_TEMPLATE/factory-ticket.md`):

```
> Type / Phase / Branch / Commit style / Design / Dependencies
## Goal
## Non-goals
## Pinned conventions
## Before implementation
## Files impacted        (New: … / Changed: …)
## Schema required       (exact columns, defaults, nullability, FK on-delete, UNIQUE, indexes)
## Definition of Done
## Tests                 (checkbox cases + verification commands that must pass)
## Acceptance Criteria   (checkboxes)
## Subtasks              (atomic, ordered)
```

Rules:
- **Non-goals** are mandatory — fence off CRUD/UI/jobs/business-logic the model might add.
- **Branch** `type/short-scope`; **Commit** `type(scope): summary`.
- **Files impacted** lists real, verified paths (New vs Changed).
- **Tests** are checkboxes and include exact `pnpm` verification commands.
- Pin defaults, nullability, FK on-delete, unique tuples, and index list explicitly.

Write each body to `docs/factory/drafts/<slug>.md`. Show the user the drafts as an
**APPROVAL GATE**. Do not create issues until the bodies are approved.

## Phase 6 — Create the issues

Confirm once: `gh auth status` succeeds and the **Factory** project exists for this repo's
owner (else point to `docs/FACTORY.md` and stop). Then per approved ticket:

```bash
scripts/factory/factory.sh create --title "<title>" --body-file "docs/factory/drafts/<slug>.md"
```

The script creates the issue, ensures the `factory` label, and adds it to the Factory
board. It prints `<number>\t<url>` — capture those. For ordered tickets, note the
`blocked by` link in a follow-up comment on the dependent issue.

To update an existing ticket in place instead of creating one:

```bash
gh issue edit <number> --body-file "docs/factory/drafts/<slug>.md"
```

## Phase 7 — Report

Summarize: a table of `#number — title — url`, plus any `blocked by` links. Keep the
draft files under `docs/factory/drafts/` unless the user says otherwise.

---

## Working-model protocol (for whoever later IMPLEMENTS a ticket)

This command creates/updates tickets. When a model actually works a ticket, it MUST
bracket the work with two comments:

- **On start**, before writing code:
  ```bash
  scripts/factory/factory.sh start <issue> "<your-model-name>"
  ```
  (posts model name + UTC start time)

- **On completion**, after the work is done:
  ```bash
  scripts/factory/factory.sh finish <issue> --total <tokens> [--in <n> --out <n>]
  ```
  (posts the token count for the ticket)

The token count comes from the working model's own usage accounting — a shell script
can't know it, so the model must supply it.
