# Documentation

Companion Planning keeps its docs in four tiers. Start with the first two; the rest are design
history. **When a doc and the code disagree, the code wins.** The first tier was audited against
the code at `3cfbbdf2` (v4.2.2 plus four commits, migration head `0172_signup_codes`) on 2026-11-01.

## 1. The app as it is now

| Doc | What it covers |
|---|---|
| [README](../README.md) | What the app does, how to run it (Docker, Compose, local dev), the environment variables, the HTTP API, the mobile shells, tests |
| [ARCHITECTURE](../ARCHITECTURE.md) | Tech stack, repository layout, data model, scheduling engine, jobs, auth, connectors, sync, deployment, backup |
| [CHANGELOG](../CHANGELOG.md) | Release notes; releases are git tags |
| [CONTRIBUTING](../CONTRIBUTING.md) | The local gate (`typecheck`, `build`, `test`, `lint:canon`), merge policy |
| [GLOSSARY](GLOSSARY.md) | The canonical vocabulary: which words mean what, and which ones were retired |
| [ROADMAP](ROADMAP.md) | What shipped, what is in progress, what is deferred |
| [Data dictionary](companion_db_data_dictionary_v2.md) · [schema (Mermaid)](companion_db_schema_v2.mermaid) | Every table and column, generated from the migrations. The v1 files ([dictionary](companion_db_data_dictionary.md)) are superseded |
| [Color styling rules](color-styling-rules.md) | The design tokens the client uses |

## 2. Running and operating it

| Doc | What it covers |
|---|---|
| [Google Cloud setup](google-cloud-setup.md) | Provisioning the OAuth client for Calendar (and optional Gmail) |
| [Home server over Tailscale](local-tailscale-setup.md) | Running it on a machine you own, reachable from your devices |
| [Error reporting](operations/error-reporting.md) | What the released images send (crashes only), and how to turn it off |
| [CI](CI.md) | The GitHub Actions workflows, all manually dispatched, and how to run the gate locally |
| [Release readiness](RELEASE-READINESS.md) | The master plan for the first public release (Phases T–Y) |
| [License FAQ](License-FAQ.md) | Licensing questions and answers (the license itself is [LICENSE](../LICENSE)) |
| [Postgres port](../server/db/postgres/README.md) | The optional Postgres store: what exists and what lags behind SQLite |
| [Backups and service files](../ops/) | Litestream, systemd and launchd units, `ops/scripts/` |
| [Video pipeline](../video/README.md) | Rendering the product videos |

## 3. Feature design notes

Written when a feature was planned or built. Each says at the top how much of it shipped.

- [People on work](people-on-work.md): Responsible and Beneficiaries (migrations 0151–0154).
- [Objectives in the Planner](objectives-in-planner.md) · [FTUE plan](ftue-plan.md) · [Plan import](plan-import.md) (planned, not built).
- [Triality](triality-design.md) and [Triality v2](triality-v2-design.md): three candidate next actions.
- [Factory](FACTORY.md): the idea-to-tickets workflow, and the ticket sets it produced in [`factory/`](factory/): balance targets, the close loop, placement learning, the plan revision loop, plus `drafts/`.
- [Complexity rubric measurement](complexity-rubric-measurement-2026-08.md).

## 4. Phase design records

Specs written before or during each phase, named by phase letter: **AA** [memory-aware agentic layer](AA-memory-agentic.md),
[AA3](AA3-smarter-autoplan.md) · **AB** [natural scheduling](AB-natural-scheduling.md) · **AD** [calendar reliability](AD-calendar-reliability.md) ·
**AE** [reflow correctness](AE-reflow-correctness.md) · **AF** [task management](AF-task-management.md), [tag unification](AF11-tag-unification.md) ·
**AG** [multi-tenant RBAC](AG-multitenant-rbac.md) · **AH** [focus × time blocks](AH-focus-timeblocks.md) ·
**F2** [calendar improvements](F2-calendar-improvements.md) · **Q** [schema hygiene](Q-schema-hygiene.md) ·
**S** [schema consolidation](S-schema-consolidation.md) · **T** [multi-tenant users](T-multi-tenant-users.md), [tickets](T-multitenant-tickets.md) ·
**U** [auth](U-auth.md), [OIDC + local](U-oidc-local-auth.md), [tickets](TICKETS-U-oidc-local-auth.md) ·
**V** [password reset](V-password-reset.md), [V-auth](V-auth.md) · **W** [GraphQL CRUD](W-graphql-crud.md), [schema](W-graphql-schema.md) ·
**X** [MCP intent vocabulary](X-mcp-intent-vocabulary.md), [audit](x-audit.md) · **Y** [environment configuration](Y-env-configuration.md) ·
**Z** [focus ritual](Z-focus-ritual.md), [naming consolidation](Z-naming-consolidation.md), [W2 brief](Z-W2-brief.md).
Also: [Tasks / Planner / Nav UI overhaul](tasks-planner-ui-overhaul.md).

These describe intent. Parts changed on the way to the code; read ARCHITECTURE and the data dictionary for what is there.

## 5. Point-in-time records

Snapshots that are not updated after the day they were written:

- Handoffs: every `HANDOFF-*.md`, [U-HANDOFF](U-HANDOFF.md), [V-HANDOFF](V-HANDOFF.md), [Z-HANDOFF](Z-HANDOFF.md), [pass A work list](passA-worklist.md).
- Reviews: [production readiness, 2026-10-21](PRODUCTION-READINESS-2026-10-21.md), [release-readiness review](RELEASE-READINESS-REVIEW.md), [launch review recap](RECAP-2026-07-12-launch-review.md), [recap of phases A–S](recap_state_A-S.md), [UI comments stub](ui-comments-2026-07-20-stub.md).
- Branch copies: the `*.branch-*.md` files, earlier copies of the S, T, W and Z specs left in place.
- [`archive/`](archive/README.md): the earlier phase plans and briefs (B0–R, CON-1…3, cockpit), kept for history. Many of their relative links no longer resolve, because the files moved.
