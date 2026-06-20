# Design brief — Recurrence & Habits, Settings (Memory sync + model picker), Responsive shell

> **Purpose:** a paste-ready prompt for Claude (design/artifacts mode) to produce
> layouts that match the **CI-Hub org design system**. It carries the full
> engineering plan so the generated UI fits the real app, not a generic one. Copy
> everything under **── PROMPT ──** into Claude; the sections above it are context
> for the team.
>
> **Governing rule: global styles first.** Every screen below is built from the
> shared **semantic design tokens** and the shared **UI primitives** — never
> hardcoded hex, never inline `style=`, never a bespoke one-off class when a global
> one exists. Reach for a raw value only to *add* it to the global theme, not to
> sidestep it.

## Engineering context (what's being built and why)

This design pass dresses three things that are about to land in code, and aligns
Companion Planning to the **CI-Hub design system** (the org-wide "deep teal-navy"
theme) so it looks like one product family:

1. **Phase E — Recurring tasks & habits.** The deterministic RRULE engine
   (`server/src/engine/recurrence.ts`) + the generation job are done/tested. What's
   missing is the UI — recurrence editor, habit streak, missed-habit surfacing,
   series-vs-instance edit — covered here. Spec: [E-recurring-habits.md](E-recurring-habits.md).
2. **Settings additions.** (a) **Ollama model selection** — Fast + Quality (+
   optional Embedding) dropdowns sourced from the live installed-model list at
   `GET /api/integrations` (`ollama.models[]`); today it's env-only. (b) **Companion
   Memory sync** — an optional, off-by-default **one-way push** of planning history
   to the user's Companion Memory via CI-Server.
3. **Responsive shell.** The app is desktop-only today (fixed left rail, centered
   modals). It must work on **mobile and desktop**.

Planning's own stack is **SolidJS + Tailwind**; CI-Hub's reference is **React +
Tailwind 4 + Radix/CVA**. The framework doesn't port, but **the design system
does** — adopt CI-Hub's global token layer and component vocabulary, expressed in
Solid. (See the implementation note at the end.)

## Design language — the CI-Hub global system (match this exactly; global styles first)

Source of truth: `CI-Hub/packages/frontend/src/styles/globals.css` (`@theme inline`
tokens) + `src/components/ui/*` (Radix + CVA primitives). The principle below is the
one the user called out — **always use global styles first**:

- **Use semantic tokens, not raw colors.** Every color is a CSS variable surfaced as
  a Tailwind class: `bg-background`, `text-foreground`, `bg-card`,
  `text-card-foreground`, `bg-primary`, `text-primary-foreground`, `bg-secondary`,
  `bg-muted`, `text-muted-foreground`, `bg-accent`, `bg-destructive`,
  `border-border`, `border-input`, `ring-ring`. Design with these names; the hex is
  an implementation detail that flips between light and dark automatically.
- **Reuse the shared primitives before building anything.** Button (CVA variants:
  `default`/`secondary`/`outline`/`ghost`/`destructive`/`link` × `sm`/`default`/`lg`/`icon`),
  Card (+Header/Title/Description/Content/Footer), Input (with label/help/error),
  Dialog, Tabs, Select, Checkbox, Switch, DropdownMenu, ScrollArea. Compose classes
  with the `cn()` helper. A new component is a last resort.
- **Theme:** dark-first brand identity, but **both light and dark are first-class**
  (system default + user toggle). Design once in semantic tokens; both modes follow.
- **Palette (deep teal-navy, org-wide).** Dark: background `#041620`, card `#0a222e`,
  raised surface `#1d293d`, primary `#abd4d8` (near-white teal) on `#041620`, accent
  `#2c676d`, border `#2c676d`, focus ring `#58ebbf`, destructive `#ef7070`. Data/accent
  ramp (use for charts, streak dots, priority markers): `#58ebbf`, `#409b9b`,
  `#079d99`, `#70a6af`, `#2c676d`. Light: background `#f3f3f3`, card `#f7f7f9`,
  primary `#0f717a`.
- **Type:** **Montserrat** (weights 200/400/500/600/700), `system-ui` fallback —
  the global `--font-sans`. No separate mono. Scale from the primitives: card title
  `text-2xl font-semibold tracking-tight`, dialog title `text-lg font-semibold`,
  labels `text-sm font-medium`, help/meta `text-xs`/`text-[0.8rem] text-muted-foreground`.
- **Shape & depth:** base radius `--radius: 0.625rem` → `rounded-lg` cards,
  `rounded-md` controls; soft `shadow-sm`; 1px `border-border`. Calm, minimal; a very
  subtle teal radial lift at the top of the page is part of the global base layer —
  don't re-add heavy shadows or gradients per-component.
- **Icons:** `lucide` (shared with CI-Hub). Focus rings use `ring-ring` for
  accessibility on every interactive element.

---

── PROMPT ──

You are a senior product designer. Design the UI for three features of
**Companion Planning** — a private, local-first, AI-assisted **time-blocking and
life-planning** app in the **Companion Intelligence** product family. Produce
**desktop and mobile** layouts, in **both light and dark mode**, for every screen
below.

**Hard rule — global styles first.** Match the **CI-Hub design system** and build
only from its shared **semantic tokens** and **UI primitives**. Never use raw hex,
inline styles, or bespoke one-off classes when a global token or primitive exists.
If you need a value that isn't in the system, note it as a *theme addition*, don't
inline it.

### Design system (use these semantic tokens — not raw colors)
Colors are CSS-variable tokens exposed as Tailwind classes; they auto-flip between
light/dark, so design in token names:
- Surfaces: `bg-background` (page), `bg-card` (panels), raised surface for popovers;
  text `text-foreground`, secondary text `text-muted-foreground`.
- Brand/interactive: `bg-primary` + `text-primary-foreground` (primary actions);
  `bg-secondary`, `bg-accent` (hover/selected), `bg-muted` (quiet fills).
- Status: `bg-destructive` (errors/danger). Focus: `ring-ring` on every control.
- Lines: `border-border`, form fields `border-input`.
- Reference palette (so you know what renders — but use the token, not the hex):
  **dark** background `#041620`, card `#0a222e`, surface `#1d293d`, primary `#abd4d8`,
  accent `#2c676d`, border `#2c676d`, ring `#58ebbf`, destructive `#ef7070`; accent
  ramp `#58ebbf · #409b9b · #079d99 · #70a6af · #2c676d`. **light** background
  `#f3f3f3`, card `#f7f7f9`, primary `#0f717a`.
- Type: **Montserrat** (200/400/500/600/700). Radius `rounded-lg`/`rounded-md`
  (base 0.625rem). Soft `shadow-sm`, 1px `border-border`. Icons: `lucide`.

### Reuse these shared primitives (don't reinvent)
Button (variants `default`/`secondary`/`outline`/`ghost`/`destructive`/`link`, sizes
`sm`/`default`/`lg`/`icon`), Card (+Header/Title/Description/Content/Footer), Input
(label/help/error states), Dialog, Tabs, Select, Checkbox, Switch, DropdownMenu,
ScrollArea, Tooltip. Build segmented controls from Tabs or a button group with an
active (`data-[state=active]`) treatment. Toggles use Switch; multi-select uses
Checkbox.

### Feature 1 — Recurrence & Habits

In the **New / Edit Task** modal (a Dialog on desktop; a full-height **bottom sheet**
on mobile):

1. **Repeat control** in the form's "More options" area — a segmented control
   (Tabs/button group): **None · Daily · Weekly · Custom**.
   - *Weekly* reveals a 7-toggle weekday row **M T W T F S S** (multi-select; active
     toggles use `bg-primary text-primary-foreground`).
   - *Custom* reveals an Input for a raw RRULE (power users) with **live validation**:
     valid → a plain-language summary in a `bg-muted` chip ("Every Mon, Wed, Fri");
     invalid → the Input's error state (`border-destructive`, `text-destructive`
     helper "That repeat rule isn't supported"); sub-daily rules rejected.
   - An **end condition** row: **Never · On date · After N times** (date Input /
     number stepper appear on selection).
   - A persistent plain-language **summary line** restating the current rule.
2. **Habit toggle** (Switch, "Make this a habit"). When on, reveal a `text-muted-foreground`
   note about streak behavior ("Skipping a day breaks the streak" — default on).
3. **Edit-scope chooser** — appears only when editing an existing recurring task. A
   prominent segmented control: **"This task"** vs **"This and future tasks"**
   (instance vs series). High-stakes — make the two unmistakable, each with a
   one-line `text-muted-foreground` consequence preview.

Outside the form:

4. **Habit streak strip** — the last 7 occurrences as dots using the accent ramp:
   **filled** (`bg-chart-1`/primary) = done, **outline** (`border-border`) = upcoming,
   **ring** = skipped, **dim** (`text-muted-foreground`) = missed — plus a streak
   count ("12-day streak"). Reads at a glance on a phone. On the task Card and in
   task detail.
5. **Recurring indicator** — a small `lucide` repeat glyph (muted) on Cards/blocks
   that are recurrence instances. Templates are managed in the editor, never listed.
6. **Missed-habit surfacing on Today** — a gentle, hopeful treatment (a `bg-muted`
   Card, not `bg-destructive`): "missed yesterday — pick it back up" with a one-tap
   action. Never punitive.

### Feature 2 — Settings additions

Settings is a single scroll column of **Card** sections. Add two more in that rhythm:

1. **Models** (Ollama). Two **Select** dropdowns — **Fast model** (extraction/triage)
   and **Quality model** (briefings) — populated from the user's installed Ollama
   models; optional third **Embedding model**. States:
   - *Available:* selects enabled; a status row with a small success dot (use
     `bg-primary`/chart-1, not raw green) and "Ollama connected · N models".
   - *Unavailable:* selects disabled; a `text-destructive` status row + calm hint
     ("Start Ollama on localhost:11434"). Never blocks the rest of Settings.
2. **Companion Memory** (optional sync). A Card section:
   - **Master toggle** (Switch) "Sync with Companion Memory" — **off by default**,
     with a `text-muted-foreground` privacy line ("Your plan stays on this device.
     Turn this on to back up and enrich it with your Companion Memory.").
   - **Connection row:** *Not connected* → a primary **Connect** Button (hands off to
     Companion Intelligence / CI-Server sign-in); *Connected* → the account + an
     `outline`/`ghost` Disconnect.
   - **What syncs** (Checkboxes, enabled only when the toggle is on): *Completed tasks
     & time actuals*, *Habits & streaks*, *Daily reflections & briefings*.
   - **Status footer:** "Last synced 2m ago" + a `secondary` **Sync now** Button; a
     syncing spinner state; an error state ("Couldn't reach Companion Memory — will
     retry"). Make clear it is **one-way push** for now.

### Feature 3 — Responsive shell (mobile + desktop)

CI-Hub uses a **sticky top Header** + centered `container` content (not a left rail).
Bring Planning's shell into that pattern and make it responsive:

- **Desktop (≥1024px):** a top Header bar (logo + primary nav + theme toggle), content
  in a centered `container` over `bg-background`. (If a side rail is kept for the 7
  views, use the `sidebar` tokens — `bg-sidebar`, `text-sidebar-foreground`, active =
  `bg-sidebar-accent`.)
- **Tablet (768–1023px):** condense nav to icons; content takes the width.
- **Mobile (<768px):** a **bottom tab bar** — Today, Calendar, Inbox (with the pending
  badge), Tasks, and a **More** overflow (Tags/Jobs/Settings) — `lucide` icons, active
  in `text-primary`. A **primary FAB** (`bg-primary`) for quick-add. Dialogs become
  **bottom sheets**; the task form is a full-height sheet. **Calendar** defaults to a
  single-day column with a day switcher (week/month behind a control); drag/resize
  works with **touch** (≥44px targets). Settings Cards stack full-width.
- Show **Today** and the **New/Edit Task sheet** (with the recurrence control) at
  mobile width specifically.

### Deliverables
For each screen/component: a **desktop and a mobile** layout, in **light and dark**,
plus key states — default, focus/selected, **error** (invalid RRULE; Ollama down;
Memory sync failed), **empty** (no habits yet), **loading/syncing**, **disabled**.
**Annotate every color with its token name** (e.g. "`bg-card`", "`text-muted-foreground`"),
not a hex. Where you output markup, use Tailwind classes bound to the semantic tokens
and compose with the shared primitives (Button/Card/Input/Dialog/Tabs/Select/Switch/
Checkbox) — **global styles first, no inline styles**. Prioritize: (1) the recurrence
editor + edit-scope chooser, (2) the habit streak + missed-habit surfacing, (3) the
two Settings sections, (4) the mobile bottom-nav + task sheet.

── END PROMPT ──

---

## Product decisions (confirmed 2026-06-19)

- **Companion Memory sync direction:** ✅ **one-way push** (Planning → Memory) for
  v1. Smallest surface, cleanest privacy story.
- **Model picker granularity:** ✅ **Fast + Quality** selects (+ optional Embedding),
  persisted to `scheduling_prefs`.
- **Mobile nav:** **bottom tab bar + More overflow**.
- **Styling baseline:** ✅ adopt the **CI-Hub global design system** (semantic tokens
  + shared primitives, Montserrat, light/dark), replacing Planning's bespoke
  hardcoded palette. Global styles first.

## Implementation plan this design unblocks (for reference)

**Styling foundation (do first — everything else builds on it):**
- Port CI-Hub's `globals.css` token layer into Planning: define the same CSS
  variables (`--background`, `--card`, `--primary`, `--accent`, `--border`, `--ring`,
  `--muted-foreground`, `--radius`, the chart ramp, `sidebar-*`) under `:root` +
  `.dark`, wire them into Planning's Tailwind theme, load **Montserrat**, add a
  light/dark toggle (default: system).
- Replace bespoke classes (`.card`, `.btn-primary`, `.input`, Source Code Pro) with
  the semantic tokens / Solid equivalents of the shared primitives. New UI uses them
  exclusively; migrate existing views opportunistically. **Global styles first** is
  the standing rule — no hardcoded hex or inline `style=` for color/spacing/radius.

**Feature work:**
- **E-PR3 — instance ops + edit scope:** `POST /api/tasks/:id/skip` (durable via
  template EXDATE), `?scope=instance|series` on `PATCH /api/tasks/:id`,
  `GET /api/tasks/:id/streak`.
- **E-PR4 — client:** recurrence control + habit Switch + edit-scope chooser in
  `TaskForm.tsx`; streak strip on `TaskCard.tsx`; missed surfacing on `Today.tsx` —
  all on the semantic-token primitives above.
- **Settings-PR — model picker:** add `fast_model`/`quality_model`(/`embed_model`)
  to `scheduling_prefs`; have `mcp/ollama.ts` honor the per-owner override (fallback
  to env); two Selects in `Settings.tsx` from `integrations().ollama.models`.
- **Settings-PR — Memory sync:** add `memory_sync_enabled` + scope flags +
  `memory_last_synced_at` to `scheduling_prefs`; a `memory` connector behind the
  Phase I/J `tokenSource` seam (stub until I lands); the Settings section as designed.
- **Responsive shell:** Header + bottom-tab-bar via Tailwind breakpoints; Dialog →
  bottom-sheet under `md`; Calendar single-day default on mobile + touch drag.
