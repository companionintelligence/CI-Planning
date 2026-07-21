> **Type:** Frontend
> **Phase:** Post-audit hardening (2026-07-20 handoff)
> **Branch:** `fix/root-error-boundary`
> **Commit style:** `fix(client): mount a root ErrorBoundary so a resource error degrades instead of white-screening`
> **Design:** this ticket is the spec (flagged in `docs/HANDOFF-2026-07-20-audit-followups.md` "Repo facts worth carrying")
> **Dependencies:** None

## Goal

The SolidJS app mounts **no `ErrorBoundary` anywhere**, so any `createResource` read
that hits a 403/500 (or any thrown error during render) crashes the whole SPA to a
blank screen. Wrap the routed view content in a single root-level `ErrorBoundary` that
renders a recoverable fallback (message + "Reload"), so a single failing view degrades
to an inline error instead of taking down the entire app.

## Non-goals

- Do **not** remove or weaken the existing per-view `resource.error` guards
  (`Jobs.tsx`, `PlanWeekReviewBranch.tsx`, etc.) — the boundary is a safety net, not a
  replacement. Leave those guards in place.
- Do **not** add per-route or per-component boundaries — one boundary wrapping the
  shell's routed children is the scope. (A finer-grained boundary can be a later ticket.)
- Do **not** add error reporting/telemetry, logging services, or Sentry-style capture.
- Do **not** change routing, auth gating (`SessionGate`), or the loading fallbacks.
- Do **not** alter server code.

## Pinned conventions

- SolidJS `ErrorBoundary` is imported from `solid-js` (same package the app already
  imports `Show`, `createResource`, etc. from — see `client/src/App.tsx:2`).
- The app renders route content through `Shell`'s `{props.children}` at
  `client/src/App.tsx:139`, inside `<div class="flex-1 overflow-auto pb-16 md:pb-0">`.
  **Both** router paths render `Shell`: `SessionGate` (auth-gated) and `UngatedRouter`
  (`Router root={Shell}`). Wrapping `{props.children}` inside `Shell` covers both — do
  it once, in `Shell`, not in each router.
- Fallback styling must match the app's existing centered-state pattern already used for
  loading fallbacks: `class="min-h-screen flex items-center justify-center bg-surface-950
  text-muted-foreground"` (see `App.tsx:206`). Reuse `bg-surface-950` / `text-muted-foreground`
  and the `Loader2`-style layout idiom; the button uses the existing primary token classes
  (`bg-primary text-primary-foreground`) seen on the toggle at `App.tsx:121`.
- `ErrorBoundary`'s `fallback` prop takes `(err, reset) => JSXElement`. Wire the reset
  callback to the button so the user can retry without a hard reload; also offer a full
  `window.location.reload()` affordance.

## Before implementation

- Read `client/src/App.tsx` (the `Shell` function, ~lines 81–166) — this is where the
  boundary goes, wrapping `{props.children}`.
- Read `client/src/views/Jobs.tsx:39` and `client/src/components/PlanWeekReviewBranch.tsx:34`
  to see the existing "no ErrorBoundary" comments; update/soften those comments to note a
  root boundary now exists (the local `resource.error` guards stay).
- Grep an existing test that renders a view under an error condition
  (`client/src/components/PlanWeekReviewBranch.test.tsx`) for the render-harness pattern.

## Files impacted

- **New:** `client/src/components/ErrorBoundaryFallback.tsx` — the fallback view
  (message + Reset + Reload), theme-matched. (Optional: inline the fallback in `App.tsx`
  if the reviewer prefers no new file; prefer the component for testability.)
- **New:** `client/src/components/ErrorBoundaryFallback.test.tsx` — renders a child that
  throws, asserts the fallback shows and that Reset re-renders.
- **Changed:** `client/src/App.tsx` — import `ErrorBoundary` from `solid-js`; wrap
  `{props.children}` in `Shell` with `<ErrorBoundary fallback={...}>`.
- **Changed:** `client/src/views/Jobs.tsx`, `client/src/components/PlanWeekReviewBranch.tsx`
  — update the "app mounts no ErrorBoundary" comments to reflect the new root boundary.

## Schema required

None.

## Definition of Done

- [ ] A single `ErrorBoundary` wraps `Shell`'s routed `{props.children}`; it applies to
      both `SessionGate` and `UngatedRouter` paths (verified by inspection — both use `Shell`).
- [ ] When a routed view throws (e.g. a resource read rejects), the app shows the
      theme-matched fallback with a working "Try again" (reset) and "Reload" control
      instead of a blank page; the nav/shell chrome remains visible.
- [ ] Existing per-view `resource.error` guards are unchanged.
- [ ] Stale "no ErrorBoundary" comments updated.
- [ ] `pnpm --filter client typecheck`, `pnpm --filter client test`, and
      `pnpm --filter client build` all pass.

## Tests

- [ ] `ErrorBoundaryFallback.test.tsx`: rendering a child component that throws shows the
      fallback text (not the thrown error to a blank DOM).
- [ ] Clicking "Try again" after the throwing condition is cleared re-renders the child
      (reset path works).
- [ ] Existing suite stays green (595+ client tests).

```
pnpm --filter client typecheck
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] Given a view whose `createResource` rejects with a 403, When it mounts, Then the
      app renders the inline fallback within the shell rather than white-screening.
- [ ] Given the error condition is transient, When the user clicks "Try again", Then the
      boundary resets and the view re-attempts render.
- [ ] No regression: the ungated (test/standalone) router and the auth-gated router both
      render the boundary (both go through `Shell`).

## Subtasks

1. [ ] Add `ErrorBoundaryFallback.tsx` (message + Reset + Reload), theme-matched.
2. [ ] Import `ErrorBoundary` from `solid-js` in `App.tsx`; wrap `{props.children}` in `Shell`.
3. [ ] Wire `fallback={(err, reset) => <ErrorBoundaryFallback error={err} onReset={reset} />}`.
4. [ ] Update the two stale "no ErrorBoundary" comments.
5. [ ] Add `ErrorBoundaryFallback.test.tsx`; run typecheck/test/build.
