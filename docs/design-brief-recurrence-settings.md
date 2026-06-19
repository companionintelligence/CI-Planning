# Design brief — Recurrence & Habits, Settings (Memory sync + model picker), Responsive shell

> **Purpose:** a paste-ready prompt for Claude (design/artifacts mode) to produce
> layouts. It carries the full engineering plan so the generated UI fits the real
> app, not a generic one. Copy everything under **── PROMPT ──** into Claude; the
> sections above it are context for the team.

## Engineering context (what's being built and why)

This design pass dresses three things that are about to land in code:

1. **Phase E — Recurring tasks & habits.** The deterministic RRULE engine
   (`server/src/engine/recurrence.ts`) and schema are **done and tested**
   (DST-safe expansion, `parseRule` validation). What's missing is a bounded
   nightly **generation job**, per-instance **complete/skip**, **missed-habit**
   surfacing, **series-vs-instance edit** scope, and **all of the UI**. The UI is
   what this brief covers. Spec: [E-recurring-habits.md](E-recurring-habits.md).
2. **Settings additions.** (a) **Ollama model selection** — today the fast/quality
   models are env-only (`OLLAMA_SMALL`/`OLLAMA_MEDIUM`); make them user-selectable
   dropdowns sourced from the live installed-model list already returned by
   `GET /api/integrations` (`ollama.models[]`). (b) **Companion Memory sync** — an
   optional, off-by-default toggle to sync planning history to the user's Companion
   Memory via CI-Server (the same identity/connector seam Phase I/J introduces).
3. **Responsive shell.** The app is desktop-only today (fixed `w-52` left rail,
   centered modals). It must work on **mobile and desktop**.

Stack the design must fit: **SolidJS + Tailwind**, dark-first, served as an
installable PWA. Output should be expressible with the existing utility classes
(`.card`, `.input`, `.btn-primary`, `.section-label`, `.modal`, `.nav-item`).

## The existing visual language (match it exactly — do not invent a new theme)

- **Mood:** private, calm, focused. Dark-first, deep-navy. Minimal, geometric,
  a retro-futuristic "previz" register. Companion Intelligence (CI) family.
- **Surfaces:** near-black navy background (`#070d11`), card/surface tiers around
  `#0b1620`–`#13212e` (`surface-900`/`800`/`700`), hairline borders `#1a3040`/
  `#244859`.
- **Signature accent — CI teal gradient:** `linear-gradient(135deg,#58ebbf,#409b9b)`
  on primary buttons, the logo mark, selected chips. Accent `#58ebbf`, accent-deep
  `#409b9b`, muted teal `#244859`, light text-teal `#ABD4D8`.
- **Priority scale (already used as dots/markers):** P1 `#ef4444`, P2 `#f97316`,
  P3 `#58ebbf`, P4 `#409b9b`, P5 `#244859`.
- **Type:** display/headings = a wide-tracked heading face in `#ABD4D8`
  (`font-heading`); body = slate-100/200 with slate-500 for secondary;
  **monospace = Source Code Pro** for inputs, buttons, labels, numerals.
- **Components:** `rounded-2xl` cards with 1px borders; **pill** buttons and
  toggles; inputs glow with a teal focus ring (`0 0 0 2px rgba(88,235,191,.25)`);
  `.section-label` = uppercase, letter-spaced, `#409b9b`; left-rail nav item active
  = 2px teal left border. Subtle teal glow on hover (`rgba(88,235,191,.08)`),
  never heavy shadows.
- **Existing screens** (for consistency): Today (focus + AI briefing), Calendar
  (2-D drag/resize grid), Inbox (review queue), Tasks (filterable list), Tags
  (weighted cloud), Jobs, Settings.
- **Brand voice in UI copy:** hopeful, not fearful; plain, not clever. A missed
  habit is a gentle nudge, never an alarm. Privacy is a feature, stated plainly.

---

── PROMPT ──

You are a senior product designer. Design the UI for three features of
**Companion Planning** — a private, local-first, AI-assisted **time-blocking and
life-planning** app (part of the Companion Intelligence ecosystem). Produce
**desktop and mobile** layouts for every screen below. Match the existing visual
language precisely; do not introduce a new theme.

### Visual system (use these tokens verbatim)
- Dark-first. Background `#070d11`; cards/surfaces `#0b1620`→`#13212e`; borders
  `#1a3040`/`#244859`.
- Signature accent is the **CI teal gradient** `linear-gradient(135deg,#58ebbf,#409b9b)`
  (primary buttons, selected states, the logo mark). Accent `#58ebbf`, deep
  `#409b9b`, muted `#244859`, light teal text `#ABD4D8`.
- Priorities: P1 `#ef4444`, P2 `#f97316`, P3 `#58ebbf`, P4 `#409b9b`, P5 `#244859`.
- Headings in `#ABD4D8`, wide letter-spacing; body in slate-100/200/500;
  **Source Code Pro** monospace for inputs, buttons, labels, and numbers.
- `rounded-2xl` cards, pill buttons/toggles, teal focus-glow on inputs, uppercase
  letter-spaced section labels in `#409b9b`. Minimal, geometric, calm. Subtle teal
  hover glow, no heavy drop shadows.
- Copy is hopeful and plain. Privacy-first.

### Feature 1 — Recurrence & Habits

Design these, in the context of the **New / Edit Task** modal (a dark
`rounded-2xl` card; on mobile it becomes a full-height **bottom sheet**):

1. **Repeat control** inside the task form's "More options" area. A segmented
   pill control: **None · Daily · Weekly · Custom**.
   - *Weekly* reveals a 7-pill weekday row **M T W T F S S** (multi-select;
     selected pills use the teal gradient).
   - *Custom* reveals a single RRULE text input for power users with **live
     validation**: valid → a plain-language summary chip ("Every Mon, Wed, Fri");
     invalid → a calm red helper line ("That repeat rule isn't supported");
     sub-daily rules are rejected.
   - An **end condition** row: **Never · On date · After N times** (date picker /
     number stepper appear as selected).
   - A persistent **plain-language summary line** that always restates the current
     rule (e.g. "Repeats every weekday, until Aug 1").
2. **Habit toggle** ("Make this a habit"). When on, reveal a small note about
   streak behavior ("Skipping a day breaks the streak" — default on).
3. **Edit-scope chooser** — appears **only when editing an existing recurring
   task**. A prominent, unambiguous segmented control: **"This task"** vs
   **"This and future tasks"**. This is a high-stakes choice (it can rewrite a
   whole series) — design it so the user cannot confuse the two. Show a one-line
   consequence preview under each option.

Also design how recurrence reads **outside** the form:

4. **Habit streak strip** — a compact row of the last 7 occurrences as dots:
   **filled** = done, **hollow** = upcoming, **ring/slash** = skipped, **broken/dim**
   = missed — plus a streak count ("12-day streak 🔥" — but tasteful, on-brand, no
   loud emoji if it clashes). Must read at a glance on a phone. Show it on the task
   card and in task detail.
5. **Recurring indicator** — a small repeat glyph on task cards and calendar blocks
   that are recurrence instances. (Template tasks are managed in the editor, never
   shown in the day list.)
6. **Missed-habit surfacing on Today** — how a missed habit appears in the day
   view: a gentle "missed yesterday — pick it back up" treatment with a one-tap way
   to do it today. Hopeful framing, never punitive.

### Feature 2 — Settings additions

The Settings screen is a single scroll column of `rounded-2xl` cards (sections:
Planning Mode, Work Hours, Block Settings, Integrations). Add two new sections that
fit that rhythm:

1. **Models** (Ollama). Two labeled dropdowns — **Fast model** (used for
   extraction & triage) and **Quality model** (used for briefings) — each a select
   populated from the user's **installed Ollama models**. Optionally a third
   **Embedding model** select. States to design:
   - *Available:* dropdowns active, a green "Ollama connected · N models" status row.
   - *Unavailable:* dropdowns disabled, a red status row with a calm hint
     ("Start Ollama on localhost:11434"). Never block the rest of Settings.
   - Show the currently-selected model as the default; selecting persists on Save.
2. **Companion Memory** (optional data sync). A new section:
   - A **master toggle** "Sync with Companion Memory" — **off by default**, with a
     one-line privacy statement ("Your plan stays on this device. Turn this on to
     back up and enrich it with your Companion Memory.").
   - A **connection row**: *Not connected* → a **Connect** button (hands off to
     Companion Intelligence / CI-Server sign-in); *Connected* → shows the account
     and a Disconnect affordance.
   - **What syncs** — checkboxes (only meaningful when the master toggle is on):
     *Completed tasks & time actuals*, *Habits & streaks*, *Daily reflections &
     briefings*. Plain labels.
   - A **status footer**: "Last synced 2m ago" + a **Sync now** button; a syncing
     spinner state; an error state ("Couldn't reach Companion Memory — will retry").
   - Make clear this is **one-way push** from Planning into Memory for now.

### Feature 3 — Responsive shell (mobile + desktop)

The app is desktop-only today: a fixed **left rail** (~208px) with a CI logo mark
and 7 nav items (Today, Calendar, Inbox [badge], Tasks, Tags, Jobs, Settings), and
centered modals. Design the responsive system:

- **Desktop (≥1024px):** keep the left rail. Show the full layout.
- **Tablet (768–1023px):** icon-only collapsed rail (labels on hover), content
  gets the width.
- **Mobile (<768px):** replace the rail with a **bottom tab bar** — Today,
  Calendar, Inbox (with the pending badge), Tasks, and a **More** overflow for
  Tags/Jobs/Settings — using the same line icons. Add a **teal-gradient FAB** for
  quick-add. Modals become **bottom sheets**; the task form is a full-height sheet.
  The **Calendar** defaults to a single-day column with a day switcher (week/month
  behind a control), and its drag/resize must work with **touch** (≥44px targets).
  Settings cards stack full-width.
- Show the **Today** screen and the **New/Edit Task** sheet (with the recurrence
  control) at mobile width specifically — those are the highest-traffic surfaces.

### Deliverables
For each screen/component, provide **both a desktop and a mobile layout**, plus the
key **states**: default, focus/selected, **error** (invalid RRULE; Ollama down;
Memory sync failed), **empty** (no habits yet), **loading/syncing**, and
**disabled**. Annotate spacing and the token used for each color. Where helpful,
output **SolidJS + Tailwind JSX** consistent with the app's existing utility
classes (`.card`, `.input`, `.input-lg`, `.btn-primary`, `.btn-secondary`,
`.section-label`, `.modal`, `.nav-item`, pill toggles, teal-gradient selected
states). Prioritize: (1) the recurrence editor + edit-scope chooser, (2) the habit
streak + missed-habit surfacing, (3) the two Settings sections, (4) the mobile
bottom-nav + task sheet.

── END PROMPT ──

---

## Product decisions (confirmed 2026-06-19)

- **Companion Memory sync direction:** ✅ **one-way push** (Planning → Memory) for
  v1. Planning pushes history out; Memory does not write back. Smallest surface,
  cleanest privacy story.
- **Model picker granularity:** ✅ **Fast + Quality** selects (+ optional
  Embedding), persisted to `scheduling_prefs`, matching the app's existing two-tier
  model use.
- **Mobile nav:** **bottom tab bar + More overflow** (default; better fit than a
  drawer for a daily-use planner). Flag if you'd prefer a drawer.

## Implementation plan this design unblocks (for reference)

- **E-PR2 — generation job + scheduler glue:** `generate_recurrences` croner job
  (bounded `HORIZON_DAYS`, idempotent via `ux_task_occurrence`), `recurring`
  template status so templates skip the today-set, missed-habit flagging.
- **E-PR3 — instance ops + edit scope:** `POST /api/tasks/:id/skip` (durable via
  template EXDATE), `?scope=instance|series` on `PATCH /api/tasks/:id`,
  `GET /api/tasks/:id/streak`.
- **E-PR4 — client:** recurrence control + habit toggle + edit-scope chooser in
  `TaskForm.tsx`; streak strip on `TaskCard.tsx`; missed surfacing on `Today.tsx`.
- **Settings-PR — model picker:** add `fast_model`/`quality_model`(/`embed_model`)
  to `scheduling_prefs` (migration + `schema.ts`), have `mcp/ollama.ts` honor the
  per-owner override (falling back to env), wire two `<select>`s in `Settings.tsx`
  from `integrations().ollama.models`.
- **Settings-PR — Memory sync:** add `memory_sync_enabled` + scope flags +
  `memory_last_synced_at` to `scheduling_prefs`; a `memory` connector behind the
  Phase I/J `tokenSource` seam (stub until I lands); a Settings section as designed.
- **Responsive shell:** `Nav.tsx` → rail on desktop, bottom tab bar on mobile via a
  Tailwind breakpoint switch; `.modal` → bottom-sheet variant under `md`; Calendar
  default day view on mobile + touch drag.
