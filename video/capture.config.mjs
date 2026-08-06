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
 *        That is the WHOLE fix for the date text: App.tsx's top-bar date is
 *        `new Date()`, and Today's/Focus's headings read `selectedDay()`, which
 *        is seeded from `localISODate()` (stores/index.ts:37) — all three come
 *        off the browser clock, not the database, so they are already
 *        byte-stable and are NOT masked. They used to be, and since Playwright
 *        paints a mask as a filled #0A222E box (video-kit capture.mjs:247-248)
 *        that put a dark rectangle over the top bar of every frame in the cut
 *        and over the Day Overview heading of the money shot. Mask only what
 *        the DATABASE decides — counts, badges, star totals — never a value the
 *        frozen clock already pins.
 *        The now-line dot (`.bg-ring`) and the Focus time-sense bar
 *        (`div.h-1.rounded-full`) stay masked: they are sub-pixel positioned
 *        from the clock against staged block boundaries, and they are decoration,
 *        not information the caption depends on.
 *
 *  5. Live counts — NOT masked any more, deliberately.
 *     Today's due badge, the Tasks "N open" line, the per-tab counts, the day-stars
 *     total and the calendar's range label all render whatever the database holds.
 *     They used to be masked, and a Playwright mask is a filled #0A222E box
 *     (video-kit capture.mjs:247-248), so the tasks-backlog frame carried three
 *     black rectangles — one of them inside the "Tasks" tab pill, which reads as a
 *     redaction bar rather than a product. The same numbers were already on screen
 *     UNMASKED in objectives-tree, which has no mask list at all, so the masking was
 *     not even self-consistent.
 *     They are stable because the STAGE is stable: README's seed line pins
 *     `--no-llm --reset --target=50`, and the staging block that follows pins the
 *     priorities, the auto-fill and the objectives. Re-stage the same way and the
 *     counts come back identical; change the stage and they SHOULD diff, which is
 *     the whole point of committing the shots.
 *     What stays masked is decoration the clock positions sub-pixel: the now-line
 *     dot (`.bg-ring`) and the Focus time-sense bar (`div.h-1.rounded-full`).
 *
 *  6. The NL "Describe it" line calls the model — but only as an overlay.
 *     server/src/routes/tasks.ts:179-187 is explicit: `parseQuick` is
 *     "deterministic, always succeeds", and the `enrichQuick` overlay is wrapped
 *     in a try/catch that falls back to the deterministic parse. So the parse is
 *     reproducible IF the model is reliably absent — which is why the stage in
 *     README.md ("The stage") exports OLLAMA_URL=http://127.0.0.1:1
 *     (config.ts:263) alongside `pnpm dev`, for the whole capture run.
 *     That also suppresses the nondeterministic subtask-suggestion chips
 *     (ElementWizard.tsx:549-555) and the "Parsed with AI enrichment" sparkle.
 *     With that pin the add-element-parsed shot CAN press Enter and film the
 *     result, which is what the caption has always claimed.
 *     The fill string is "pay invoice 3pm #work #invoices ~20m", and every token
 *     in it is load-bearing:
 *       - no relative day words ("fri"). Playwright's clock freezes the BROWSER;
 *         chrono runs server-side against the runner's real clock, so "fri" would
 *         print a date months away from the frozen today.
 *       - "#invoices" is neither a direction (home/work/community, migration 0036)
 *         nor one of the six fixed Balance categories (PrioritiesWizard.tsx:17-24:
 *         health/career/relationships/growth/leisure/finance), so it survives the
 *         direction split (ElementWizard.tsx:480-486) as an INTENTION chip — the
 *         shot's proof selector.
 *       - "#work" IS a direction, and it has to be there. The intention chips are
 *         rendered only by TagSection, which ElementWizard.tsx:1366 gates behind
 *         `<Show when={tab() === 'task' ? !!primary() : true}>`; the FAB opens the
 *         wizard with `kind: null`, i.e. the Task tab (App.tsx:202,
 *         ElementWizard.tsx:96-97), and the closed→open effect resets `primary` to
 *         '' (ElementWizard.tsx:335). `parseNl` only calls `setPrimary` when the
 *         line carries a direction, so a direction-free line leaves TagSection
 *         unmounted: the "#invoices" chip never enters the DOM, the shot's
 *         `waitFor` burns its 20s and FAILS the whole capture step. The same empty
 *         `primary` also makes `gateRight()` true (ElementWizard.tsx:817), which
 *         renders the right-hand time/duration pane at `opacity-50` + `inert`
 *         (ElementWizard.tsx:1647-1649) — i.e. the exact fields the caption
 *         advertises, greyed out. "#work" fixes both: it lands on the primary axis
 *         and "#invoices" lands in the chips.
 *
 *  6b. The week grid opens ABOVE the day's content — RE-CHECK THIS, IT HAS MOVED.
 *     /calendar week view renders the 07:00-21:00 band (day-axis.ts:29-33) into a
 *     scroll container roughly 8.5 hours tall, scrolled to the top. This used to be a
 *     real problem: server/test/fixtures/calendar.json was authored in Pacific
 *     wall-clock and stored with a Z suffix, so against `timezoneId: "UTC"` every
 *     fixture meeting landed seven hours late — a "Lunch with mentor" at 19:30, a
 *     "Gym - leg day" at 01:00, and the whole staged week packed into 14:00-22:00.
 *     The fixture has since been re-timed to sensible UTC working hours (08:00-17:00,
 *     same calendar dates), which is what a real week looks like and is also what the
 *     week grid's default 07:00-onward viewport shows WITHOUT scrolling.
 *     -> the calendar-week shot's `before` still scrolls the container to its end.
 *        That is now probably wrong — verify the frame before trusting it, and drop
 *        the scroll if the unscrolled grid already reads.
 *     Note the day-name header row does NOT survive a scroll: it is `sticky top-0`
 *     inside `div.overflow-auto.rounded-xl`, and an overflow ancestor is its sticky
 *     scrollport even when that ancestor is not the element actually scrolling (the
 *     page's main column is), so it scrolls away with the grid. Not scrolling keeps
 *     the day names, which is a second reason to re-check.
 *
 *  7. Empty screens are a staging problem, not a capture bug.
 *     The seeder creates tasks with no `scheduled_for`, so Today's Planner and
 *     Flight-plan are EMPTY until something places them; /balance renders a
 *     "No priorities set yet" card until priorities exist; and the Objectives
 *     tab renders an empty tree, because `seed-test-data.ts` creates no
 *     objectives at all. Every one of those `waitFor`s matches in the empty
 *     state too, so the shot goes green and films a lie.
 *     -> staging is now a human step again: .github/workflows/video.yml was
 *        deleted in #483 when the cut moved to local builds, so the API calls it
 *        used to run (auto/fill -> auto/run -> auto/fill, a priorities POST, and
 *        the objectives POSTs the objectives-tree shot needs) live in README.md
 *        under "Staging — run this before `npm run capture`". Run them, or the
 *        capture is green and empty. Nothing in THIS file can paper over it —
 *        but see `fixedTime` below, which is the other half.
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
const ONBOARDED_AT = "2026-06-01T08:12:00.000Z";

export default {
  baseURL: process.env.APP_URL ?? "http://localhost:5173",

  // CI apps are dark-first. Pinned locale/timezone/clock keep captures stable.
  //
  // The clock MUST sit inside the seeded fixture window or Today, Focus and the
  // week grid all film empty. The only time_blocks the stage ever creates are the
  // 18 Google-fixture meeting mirrors (seed-test-data.ts:143-152), and
  // server/test/fixtures/calendar.json spans 2026-05-29 .. 2026-06-06. The old
  // 2026-06-15T15:04Z default was NINE DAYS past the end of that window, so
  // stores/index.ts fetched an empty day range and Today rendered its "Nothing
  // scheduled yet." branch under narration about a cockpit.
  //
  // The fixture was re-timed: it had been authored in Pacific wall-clock and stored
  // with a Z suffix, which against `timezoneId: "UTC"` rendered every meeting seven
  // hours late (lunch at 19:30, gym at 01:00, the whole week piled into the evening).
  // It now carries plausible UTC working hours on the same calendar dates, so the
  // clock below moved with it — 11:20Z, not 18:20Z.
  //
  // 2026-06-03T11:20Z is a Wednesday chosen deliberately:
  //   - that day holds Legal review 09:30-10:00, Kwaai working session
  //     11:00-12:00 and Lunch with mentor 12:30-13:30, all inside the visible
  //     07:00-21:00 band (day-axis.ts:29-33) rather than the collapsed bars;
  //   - 11:20 falls INSIDE the Kwaai session, so Focus's "the block you're in"
  //     is literally true at the shutter;
  //   - weekDaysOf is Monday-start (client/src/lib/dates.ts:94-98), so the week
  //     grid anchors Mon 1 - Sun 7 June and contains 17 of the 18 fixture events,
  //     with "today" mid-week so the grid reads with days on both sides. The
  //     eighteenth ("Dad's birthday dinner", 2026-05-29T19:00:00Z — Friday
  //     May 29) sits in the week BEFORE the anchor and is out of frame. Do not
  //     round that up to "all 18": monthGridOf is Monday-start too and Jun 1 2026
  //     IS a Monday (dates.ts:128-134), so the month grid runs Jun 1 .. Jul 12
  //     with no leading May cells — May 29 is outside that grid as well.
  // Override when the staged database is keyed to a different day — the client
  // derives "today" from this clock, so it must agree with whatever the server
  // was seeded and staged with or Today renders an empty grid (hazard 7).
  colorScheme: "dark",
  locale: "en-US",
  timezoneId: "UTC",
  fixedTime: process.env.CI_VIDEO_FIXED_TIME ?? "2026-06-03T11:20:00Z",

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
