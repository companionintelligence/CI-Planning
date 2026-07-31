# [Factory] Triality T6 — dismissable suggestion banner on Focus

> **Type:** Frontend · **Phase:** Triality Wave 4 · **Branch:** `feat/triality-focus-banner` · **Commit style:** `feat(focus): Triality banner — Habitual · Contextual · Novel` · **Design:** `docs/triality-design.md` §9.1 (owner-locked: Focus = the suggestion surface) · **Dependencies:** T4 (REST + api.ts)

## Goal

`TrialityBanner.tsx` — the one and only suggestion surface. A dismissable banner
on the Focus view between the header/Time-Sense hero and the today list: three
pills (title + category swatch + slot label **Habitual / Contextual / Novel**),
*open* and *stage* per pill, score breakdown behind a tap, refusal/empty states
honest and compact. The banner ✕ dismisses the whole banner for the rest of the
owner-local day.

## Non-goals

No Balance mount and no chips anywhere on Balance — Balance is measurement-only
(T7). Today is a standing non-goal (Phase AC declutter). No LLM rationale (T9).
No auto-scheduling — *stage* calls the existing flight-plan POST, nothing else.
No server-side dismissal persistence (v1 rule below) and no cross-device sync of
the collapsed state.

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- Mount: `client/src/views/Focus.tsx`, AFTER the Time-Sense hero block, BEFORE
  the upcoming list. ⚠️ Solid module-scope `createMemo` ordering gotcha — declare
  the banner's resource in view order, never hoisted above what it reads.
- Gating: `prefs()?.triality_enabled`; flag off → no render, zero
  `/api/triality/*` requests.
- **Dismissal semantics (design §9.1):** ✕ stamps `dismissed` via
  `api.triality.feedback` on every still-unactioned shown row from this render,
  then writes `localStorage['triality_banner_dismissed'] = <owner-local date>`
  and collapses. On mount, skip fetch entirely when the stored date == today
  (owner-local, from the prefs timezone — not `new Date()` naïvely). Per-device
  is accepted v1 behavior; say so in a code comment.
- Per-pill ✕ is NOT a thing — dismissal is banner-level (owner ruling). Acting
  on a pill (open/stage) stamps its outcome and leaves the banner up.
- Pills: category swatch via the shipped texture/color tokens (0134 hues);
  slot label small-caps muted, matching the Metrics tile label idiom; motivation
  glyph per §9.2 (● me · ◐ us · ○ them; unlabeled → no glyph) with an accessible
  title ("for me" / "for us" / "for them").
- *Open*: TaskCard/ElementWizard path (`setElementModal` idiom); *stage*:
  `POST /api/flight-plan` + `showToast`.
- ⚠️ Mount discipline (0137 CloseRitual lesson): the breakdown popover is
  card-local and read-only — fine; never attach confirmation flows to a pill a
  refetch can unmount.
- Refusal copy (compact): "Not enough history yet (N of 10)" — one line, links
  nowhere, never blocks the view.

## Before implementation

Read: `views/Focus.tsx` top-to-bottom (resource ordering + hero block),
`CloseRitual.tsx` header, the reminders card section (spacing idiom), T4's
api.ts additions.

## Files impacted

- **New:** `client/src/components/TrialityBanner.tsx`,
  `client/src/components/TrialityBanner.test.tsx`
- **Changed:** `client/src/views/Focus.tsx` (mount + resource)

## Schema required

None.

## Definition of Done

- [ ] Flag off → absent, zero requests; flag on → banner with three pills or
      honest refusal line
- [ ] ✕ → `dismissed` stamps on unactioned rows + collapsed until next
      owner-local day + no further fetches today (incl. across remounts)
- [ ] Open/stage stamp `opened`/`staged` exactly once each; banner persists
      after acting
- [ ] Breakdown tap shows F/H/Q/N/C + fired dims (arithmetic-as-explanation)
- [ ] Dark + light themes; today list layout unshifted

## Tests (jsdom, mocked api + mocked localStorage)

- [ ] flag off → nothing rendered, nothing fetched
- [ ] three pills render with slot labels; category swatches present
- [ ] ✕ → feedback called once per unactioned shown row, localStorage stamped
      with the owner-local date, banner gone
- [ ] remount with today's dismissal key → no fetch, no render
- [ ] stale (yesterday's) key → fetch + render (day rollover)
- [ ] stage → flight-plan POST then `staged` feedback (order asserted), toast
- [ ] refusal payload → compact copy, no pills
- [ ] acted-on pill excluded from the ✕ dismissal stamps

Verify: `pnpm --filter client test` · `pnpm --filter client typecheck`.

## Acceptance Criteria

A flag-on owner opening Focus sees three actionable suggestions exactly where
"what now" is asked, can act without leaving the view, and can make the banner
gone for the day with one tap; a flag-off owner sees a byte-identical Focus.

## Subtasks

1. Banner + pills + gating + resource (ordering-safe)
2. Dismissal semantics (feedback fan-out + localStorage day key)
3. Actions + breakdown popover
4. Refusal/empty states
5. Test battery above
