> **Type:** Frontend · **Phase:** Audit follow-up (2026-07-19) · **Branch:** `feat/settings-calibration-pins` · **Commit style:** `feat(settings): calibration combo suggestions + pins` · **Design:** this ticket is the spec (the §2.3 hybrid per `server/src/routes/calibration.ts`'s own header) · **Dependencies:** none

## Goal

Surface the tag-combo calibration workflow. The server computes divergent tag-combo estimate
biases (`detectComboSuggestions`) and treats a POSTed pin as "the explicit human confirmation
that persists" — but **no owner has ever been able to see or act on a suggestion**: zero client
callers exist for `GET /api/calibration/scopes` and `POST/DELETE /api/calibration/pins`. After
this ticket, Settings shows the suggestions ("tasks tagged #deep + #writing run ~1.4× long —
pin this?"), the active pins, and unpin.

## Non-goals

- **No server changes** — routes, validation, audit, and recompute are built and tested
  (`server/test/time-sense.test.ts:286-300, 379+`). Client-only diff.
- **No changes to the single-task estimate nudge** (`ElementWizard.tsx:194-202, 1334-1351`) —
  it stays as-is; this ticket is the combo-scope confirm workflow only.
- No new flags; no editing of `estimate_calibration` rows directly.

## Pinned conventions

- **Routes (verbatim, `server/src/routes/calibration.ts`):**
  `GET /api/calibration/scopes` → `{ rows: [{ scope_kind, scope_ref, computed_at, sample_count,
  bias_ratio, p25, p50, p75 }], pins: [{ scope_ref, created_at }], suggestions: ComboSuggestion[] }`
  (L37-51). `POST /api/calibration/pins` body `{ tag_ids: string[] }` (2+ owned tag ids) →
  `{ ok, scope_ref }` | 422 `'tag_ids must be 2+ tag ids'` | 422 `'unknown tag id'`; success
  recomputes immediately via `calibrateEstimates()` (L73-99). `DELETE
  /api/calibration/pins/:scopeRef` → `{ ok: true }` | 404 `'pin not found'`; also drops the
  combo's `estimate_calibration` row so the bias stops immediately (L103-120). All three are
  Time-Sense-gated (404 when off).
- **`ComboSuggestion`** (`services/calibration.ts:311-318`): `{ scope_ref, tag_ids: string[],
  sample_count, combo_bias, component_bias }`. `scope_ref` = sorted `'+'`-joined tag ids
  (`comboRef`, :36-38). Suggestions are already filtered (unpinned, ≥5 samples, ≥0.25
  divergence) and sorted — render in server order.
- **Label resolution is client-side:** map each `tag_ids` entry through the `tags()` store to
  names (`#deep + #writing`); an id with no live tag renders as `unknown` (deleted tag).
- **Bias copy:** render `combo_bias` as a multiplier with one decimal (`~1.4× typical`), and the
  divergence context from `component_bias` (`vs ~1.1× for its tags alone`).
- **Placement:** Settings → the Routine Settings card's Time-Sense nested column — directly
  below the `calibration_loop_enabled` Toggle (`Settings.tsx:1083`, inside the
  `<Show when={form().time_sense_enabled}>` opened at :1075, column div at :1076). The panel is
  NOT bound to the `form()` machinery (that is for pref fields) — it reads its own resource.
- **Resource idiom to copy** (`ElementWizard.tsx:194-202`): `createResource` whose source
  returns null unless gated — here
  `prefs()?.time_sense_enabled && prefs()?.calibration_loop_enabled !== false`; fetcher
  `api.calibration.scopes().catch(() => null)`. Local `refetch` after pin/unpin.
- **api additions** (extend the `calibration` block, `api.ts:362-367` — do NOT touch the
  unrelated legacy `api.review.calibration()` at :374): `scopes()`, `addPin(tag_ids: string[])`,
  `removePin(scopeRef)` with `encodeURIComponent(scopeRef)` in the path (`scope_ref` contains
  `+`). New types (`CalibrationScopes`, `ComboSuggestion`) near `EstimateSuggestion`
  (`api.ts:969-980`).
- **Chip styling idiom** for Time-Sense affordances (`ElementWizard.tsx:1334-1351`):
  `border border-border bg-background/60 rounded-md text-[11px] px-2 py-1.5` rows with small
  action buttons.

## Before implementation

1. `server/src/routes/calibration.ts` in full — the three routes + gate.
2. `server/src/services/calibration.ts:29-38, 311-373` — thresholds, `comboRef`, suggestion
   semantics (so the UI copy states them honestly).
3. `client/src/views/Settings.tsx:1058-1091` — the card + nested Time-Sense column; confirm
   anchors.
4. `client/src/components/ElementWizard.tsx:194-202, 1334-1351` — the resource + chip idioms.

## Files impacted

**Changed:**
- `client/src/lib/api.ts` — `calibration.scopes/addPin/removePin` + `ComboSuggestion`/
  `CalibrationScopes` types.
- `client/src/views/Settings.tsx` — mounts the new panel below the calibration Toggle.

**New:**
- `client/src/components/CalibrationPins.tsx` — the panel (suggestions list + pinned list),
  self-contained resource.
- `client/src/components/CalibrationPins.test.tsx`.

## Schema required

**None.**

## Definition of Done

- [ ] With Time-Sense + calibration on, Settings shows: each suggestion as
      `#tag + #tag · ~N.N× typical (vs ~N.N× for its tags alone) · n samples` with a **Pin**
      button; each existing pin as `#tag + #tag` with an **Unpin** button.
- [ ] Pin calls `addPin(suggestion.tag_ids)` (the ORIGINAL ids, not a re-split of scope_ref),
      then refetches — the suggestion moves to the pinned list (server excludes pinned combos
      from suggestions).
- [ ] Unpin calls `removePin(scope_ref)` URL-encoded, then refetches; a 404 refetches silently.
- [ ] Zero suggestions + zero pins → a single quiet line ("No combo patterns detected yet —
      pins appear after ~5 completed tasks share a tag pair."), no empty chrome.
- [ ] The panel does not render at all when the master or channel flag is off (resource never
      fires — assert no fetch).
- [ ] 422 responses surface via `showToast` with the server's message.
- [ ] `git diff main -- server/` is empty.

## Tests

`CalibrationPins.test.tsx` (store-mock pattern; `tags()` seeded with named tags):

- [ ] Renders suggestion rows with resolved names, multiplier copy, and sample count.
- [ ] Pin fires `addPin` with the suggestion's `tag_ids` array and refetches.
- [ ] Unpin fires `removePin` with the encoded `scope_ref` and refetches.
- [ ] Flag off → no fetch, nothing rendered.
- [ ] A `tag_ids` entry missing from `tags()` renders `unknown` without crashing.

Suites to keep green:

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] An owner can see every detected combo divergence, confirm one as a pin, and remove one —
      the full §2.3 hybrid loop is finally operable.
- [ ] Pinning immediately biases future estimate suggestions (server recompute — already built).
- [ ] No server diff.

## Subtasks

1. [ ] Add the api methods + types.
2. [ ] Build `CalibrationPins.tsx`; mount in Settings at the pinned anchor.
3. [ ] Write the component tests; run the three verification commands green.
