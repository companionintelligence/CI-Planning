---
name: Factory ticket
about: A commit-recipe unit of work for the Factory project. One ticket = one atomic, testable change an LLM can execute without guessing.
title: "[Factory] "
labels: factory
---

<!--
Fill the metadata block, then every section. A good Factory ticket reads like a
git commit recipe: exact files, exact schema, exact constraints, exact verification
commands. Anything left to interpretation is a bug in the ticket. Use "None" / "N/A"
where a section genuinely doesn't apply — don't delete headings.
-->

> **Type:** <!-- Backend / DB Migration / Frontend / Infra / Refactor / ... -->
> **Phase:** <!-- e.g. v2 Phase 5 — Content Outreach -->
> **Branch:** `type/short-scope`
> **Commit style:** `type(scope): summary`
> **Design:** <!-- link to design doc, or "this ticket is the spec" -->
> **Dependencies:** <!-- other tickets/PRs, or "None" -->

## Goal

<!-- One or two sentences: the outcome and why. -->

## Non-goals

<!-- Explicit fences so the model doesn't build adjacent things. Be concrete. -->

- Do not …
- Do not …

## Pinned conventions

<!-- Exact, verified conventions this change must match (naming, types, FK behavior,
     enum/constraint approach, id generation, timestamps). Pin values; don't say
     "match convention" without stating what it is. Write "N/A" if none. -->

## Before implementation

<!-- The exact files/patterns to read first so the model matches reality. -->

## Files impacted

<!-- New: … / Changed: … — real paths. -->

## Schema required

<!-- Exact tables/columns/constraints/indexes, or "None". Include defaults, nullability,
     FK on-delete, and unique tuples. -->

## Definition of Done

<!-- The concrete checklist that must all be true to close. -->

- [ ]
- [ ]

## Tests

<!-- The exact tests (as checkboxes) plus the verification commands that must pass. -->

- [ ]
- [ ]

```
# verification commands
```

## Acceptance Criteria

<!-- Observable, verifiable checks. Given/When/Then where useful. -->

- [ ]
- [ ]

## Subtasks

<!-- Atomic, ordered steps. Keeps the work reviewable. -->

1. [ ]
2. [ ]

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
