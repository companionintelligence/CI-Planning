/**
 * Capture stage for Companion Planning.
 *
 * `ci-video capture` drives the REAL app through this config, so whatever it
 * takes to get a brand-new user to a filmable screen belongs here: the base
 * URL, any pre-authenticated session, route mocks, and seeding.
 *
 * ── The stage ────────────────────────────────────────────────────────────────
 * Vite dev server on :5173 proxying /api -> the Koa server on :3848
 * (client/vite.config.ts). Boot both with `pnpm dev` from the repo root
 * (package.json: concurrently server+client). SQLite is the only backing store,
 * so there are no other services to stand up.
 *
 *   corepack enable && pnpm install
 *   pnpm --filter server migrate
 *   GOOGLE_MODE=fixture pnpm dev        # client :5173, server :3848
 *
 * ── No login wall ────────────────────────────────────────────────────────────
 * server/src/lib/config.ts:289 defaults AUTH_MODE to 'test', and client/src/App.tsx
 * renders `UngatedRouter` in that mode — no /login route even exists. So no
 * `storageState` is needed. Deliberately left commented out below rather than
 * deleted, because an sso-mode stage WOULD need one.
 *
 * ── DETERMINISM HAZARDS FOUND IN THE SOURCE ──────────────────────────────────
 * Every one of these was read out of the app, not guessed. Ordered by how badly
 * it breaks a capture.
 *
 *  1. SSE keeps the network permanently busy.
 *     client/src/lib/sse.ts:70 opens a long-lived `EventSource` at boot and never
 *     closes it. Playwright's default `waitUntil: "networkidle"` can therefore
 *     NEVER settle — every shot would burn its 45s goto timeout and fail.
 *     -> every shot in storyboard.json pins `waitUntil: "domcontentloaded"` and
 *        leans on a real `waitFor` selector plus a generous `settle` instead.
 *
 *  2. The first-run wizard covers every route.
 *     client/src/components/OnboardingWizard.tsx:61 gates on
 *     `prefs().onboarded_at == null` — NOT on route — so on a fresh database the
 *     overlay sits on top of Today, Focus, Calendar, everything. Worse, its own
 *     Skip/Finish writes `onboarded_at` to the server, so "click Skip on the
 *     first shot" would work for the desktop pass and then silently produce a
 *     DIFFERENT app for the mobile pass (src/capture.mjs loops viewports outside
 *     the shot loop, sharing one server).
 *     -> the `GET /api/prefs` interceptor below decides per-shot instead, from
 *        the URL, and never mutates the server. Shots that want the wizard ask
 *        for it with `?ftue=1`; every other shot is pinned onboarded.
 *     Caveat, stated plainly: the ftue-trust-dial shot still clicks the wizard's
 *     own Next buttons, and steps 1 and 2 DO write (owner profile, workday
 *     bounds, planner collapse bounds). Both writes are idempotent — every field
 *     is hydrated from `prefs()` before it is written back — so the desktop and
 *     mobile passes send identical values. Neither one touches `onboarded_at`;
 *     only Skip/Finish does (OnboardingWizard.tsx:138), and no shot clicks those.
 *
 *  3. `pnpm seed` runs task extraction through Ollama by default.
 *     server/src/scripts/seed-test-data.ts mines the email/calendar fixtures with
 *     an LLM unless `--no-llm` is passed, so two seeds produce different task
 *     titles and a "UI drift" PR that is really model noise.
 *     -> stage with `pnpm --filter server seed -- --no-llm --reset`. That takes
 *        the deterministic fallback path. (`--reset` is DESTRUCTIVE and wipes
 *        tasks/possibles/blocks/tags for ALL owners — a throwaway DB_PATH only.)
 *
 *  4. Wall-clock leaks into the pixels in five places.
 *     App.tsx top bar prints `new Date().toLocaleDateString`; Today's header
 *     prints weekday + month/day; Planner.tsx:699 and CalendarGrid.tsx:115 tick a
 *     now-line every 60s; Focus.tsx:53 and Today.tsx:74 tick every 30s; the
 *     Focus time-sense bar depletes continuously.
 *     -> `fixedTime` below freezes Date AND the timers (Playwright's clock is
 *        installed before first navigation), so none of these advance mid-shot.
 *        Belt and braces: the date text and the now-line dot are also masked in
 *        storyboard.json, because they still differ between two differently
 *        staged databases.
 *
 *  5. Live counts.
 *     Today's due badge, the Tasks "N open" line and the per-tab counts all
 *     render whatever the database happens to hold. Masked per-shot.
 *
 *  6. The NL "Describe it" line calls the model.
 *     ElementWizard.tsx parses the typed line via the server on Enter, and the
 *     result varies with whichever Ollama tag is installed. The add-element shot
 *     therefore FILLS the line and deliberately does NOT press Enter — we film
 *     the input, not the parse.
 *
 *  7. Empty screens are a staging problem, not a capture bug.
 *     The seeder creates tasks with no `scheduled_for`, so Today's Planner and
 *     Flight-plan are EMPTY until something places them, and /balance renders a
 *     "No priorities set yet" card until the Priorities wizard has been run once.
 *     See video/README.md for the staging checklist. Nothing in this file can
 *     paper over it — the frames would just be honestly boring.
 *
 *  8. The published container cannot be the stage.
 *     Dockerfile:47 sets NODE_ENV=production, and server/src/lib/config.ts:403
 *     hard-refuses to boot with AUTH_MODE=test in production. docker-compose.yml
 *     pins AUTH_MODE=sso, which puts a real login wall in front of every shot.
 *     Capture from source.
 */

/** Where the first-run wizard is wanted. Any shot whose path carries this is
 *  served `onboarded_at: null`; everything else is served an onboarded value. */
const FTUE_MARK = "ftue=1";

/** Frozen, arbitrary, and in the past relative to `fixedTime` — its only job is
 *  to be non-null so the wizard stays shut on non-FTUE shots. */
const ONBOARDED_AT = "2026-06-15T08:12:00.000Z";

export default {
  baseURL: process.env.APP_URL ?? "http://localhost:5173",

  // CI apps are dark-first. Pinned locale/timezone/clock keep captures stable.
  // 2026-06-15T15:04Z is a Monday mid-afternoon: a planner has something to show.
  // Override when the staged database is keyed to a different day — the client
  // derives "today" from this clock, so it must agree with whatever the server
  // was seeded with or Today renders an empty grid (hazard 7).
  colorScheme: "dark",
  locale: "en-US",
  timezoneId: "UTC",
  fixedTime: process.env.CI_VIDEO_FIXED_TIME ?? "2026-06-15T15:04:00Z",

  // Not needed in AUTH_MODE=test (the default) — kept as the hook an sso-mode
  // stage would use.
  // storageState: "./.auth/state.json",

  async onContext(context, { viewport, page }) {
    // Warn loudly if an external asset fails — an unstyled capture looks like a
    // UI regression but is really a network failure. Nothing in this app should
    // reach off-box at all; a hit here is worth investigating on its own.
    context.on("requestfailed", (req) => {
      if (/fonts\.(googleapis|gstatic)|cdn\./.test(req.url())) {
        console.warn(`  ! external asset failed: ${req.url()}`);
      }
    });

    // Hazard 2. Decide the onboarding gate per-shot, from the URL, by rewriting
    // ONE field on the real response — everything else about /api/prefs stays
    // genuine (workday bounds, trust mode, planner collapse bounds all still
    // come from the server, so the wizard shows real values).
    //
    // Matching is exact: `**/api/prefs` does not match /api/pattern-prefs,
    // /api/category-prefs or /api/connection-prefs, which must pass through.
    // Only GET is touched; the wizard's own PATCH goes straight to the server,
    // and the refetch that follows it lands back here and stays consistent.
    await context.route("**/api/prefs", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      let body;
      try {
        body = await response.json();
      } catch {
        return route.fulfill({ response }); // not JSON (an error page) — pass it through
      }
      if (body && typeof body === "object" && body.prefs) {
        body.prefs.onboarded_at = page.url().includes(FTUE_MARK) ? null : ONBOARDED_AT;
      }
      await route.fulfill({ response, json: body });
    });

    void viewport; // both viewports share this stage; kept for future per-format setup
  },
};
