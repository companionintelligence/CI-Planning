# [Factory] Triality T9 — Ollama rationale garnish + GLOSSARY + docs sync

> **Type:** Backend garnish + docs · **Phase:** Triality Wave 5 · **Branch:** `feat/triality-garnish-docs` · **Commit style:** `feat(triality): optional AI rationale; docs + glossary sync` · **Design:** `docs/triality-design.md` §8 (garnish), §2 (naming), §11 · **Dependencies:** T6 (banner), T7 (metrics), T8 (job counts final)

## Goal

Two closers. (1) The optional one-line Ollama rationale per pick — labeled AI,
deterministic template fallback, never blocking, never in the scoring path;
rendered in the banner's breakdown popover. (2) The documentation debt paid in
the shipping wave: GLOSSARY entries, README/ARCHITECTURE additions (including
the job-count bump from T8), and flipping the design doc's status box to SHIPPED.

## Non-goals

No scoring changes, no new weights, no prompt experimentation beyond one small
template, no README restructuring beyond the pinned insertion points.

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- Rationale precedent: the `daily_plan` "why now" line — small model
  (`config.ollamaSmallModel` via `mcp/ollama.ts` `generate`), one sentence, UI
  labels AI vs template honestly (the "AI Briefing" vs "Day Overview" idiom).
  Ollama-only (local-first invariant).
- 3B-class prompt gotchas (HANDOFF-2026-07-27): output-shape instruction FIRST,
  trailing rules get ignored, no refusal-clause reliance. Fallback template:
  "Fits your `<top dim>` right now" — the fallback is the spec, the LLM decorates.
- GLOSSARY (`docs/GLOSSARY.md`): entries for **Triality**, **Habitual /
  Contextual / Novel**, **Triality banner**, **learned weights**, **motivation
  (me/us/them)** — and the two mandated disambiguations: *Habitual (slot) ≠
  Habit ◯ (pattern type)* and *`us` (motivation) ≠ Community (direction tag)*.
- README: one "What you get" bullet (banner on Focus + metrics on Balance +
  bounded learning, flag-off default); HTTP-API rows for `GET /api/triality/next`,
  `POST /api/triality/feedback`, `DELETE /api/triality/weights`,
  `GET /api/metrics/triality`; schema rows for `triality_log` +
  `triality_weights`; **job counts 19→20 cron rows / 20→21 kinds** (mermaid line
  + Project-status Croner line — the two spots PR #432 last touched); dated
  migration-head line updated in its ONE spot (PR #431 convention).
- ARCHITECTURE: schema rows, job table row for `calibrate_triality`
  (owner-scoped note), one §-line in the post-AG list, status-line head bump.
- Design doc: status box → SHIPPED + PR links; §11 stays as the decision record
  with its reversal audit trail intact.

## Before implementation

Read: `agents/plan.ts` rationale site; `docs/GLOSSARY.md` style;
HANDOFF-2026-07-27 gotcha list; README insertion points; T8's final job wiring.

## Files impacted

- **New:** none
- **Changed:** `server/src/services/triality.ts` (optional rationale field),
  `client/src/components/TrialityBanner.tsx` (labeled rationale line),
  `docs/GLOSSARY.md`, `README.md`, `ARCHITECTURE.md`, `docs/triality-design.md`

## Schema required

None (`scores` JSON gains optional `rationale` + `rationale_source:
'ai'|'template'` — JSON, no migration).

## Definition of Done

- [ ] Ollama up → labeled AI one-liner; down → template line, no latency stall
      (reuse the existing degrade timeout pattern)
- [ ] Garnish invariance: picks/scores byte-equal with rationale on and off
- [ ] GLOSSARY + README + ARCHITECTURE land; job counts and head line correct;
      design-doc box flipped

## Tests

- [ ] rationale fallback: stubbed-down Ollama → template + `source:'template'`
- [ ] garnish invariance asserted score-for-score
- [ ] banner renders the AI/template label from `rationale_source`, never unlabeled
- [ ] docs DoD check: `triality` present in GLOSSARY, README API table +
      schema table, ARCHITECTURE schema + jobs tables (manual checklist)

Verify: `pnpm --filter server test` · `pnpm --filter client test` · both typechecks.

## Acceptance Criteria

Each banner pick can say why in one honest line; every doc a future truth-pass
reads already tells the truth about Triality, including the new job.

## Subtasks

1. Rationale generation + fallback + timeout
2. Banner label line
3. GLOSSARY / README / ARCHITECTURE / design-doc edits
4. Tests above
