# UI surface review protocol

Automated checks cover rendered browser states, not every component in the source tree or native-device behavior. Use this protocol alongside the named Playwright projects in `tests/container/playwright.config.ts`.

## With each surface migration

- Extend the feature's named Playwright project; use owner-scoped fixtures and clean up only test-owned records.
- Assert the surface by role and accessible name, its primary action, and its close path. For dialogs, include keyboard focus entry, Tab containment, Escape or documented non-dismissible behavior, and focus return.
- For bounded mobile surfaces, check the visual viewport at 430 × 560 and 430 × 420. Add a tablet or desktop width when placement changes at a breakpoint.
- Run axe against the changed route or dialog in light and dark themes. Cover the changed conditional state, not only the initial state.
- Attach a screenshot and trace to failed CI runs. A passing axe scan does not count as a visual review.

The mobile Details sheet migration is the current example: `accessibility.spec.ts` scans the modal in both themes and verifies its bounds, initial focus, Tab cycling, Escape, backdrop dismissal, and focus return.

## Periodic route and theme review

Run a visual sweep for each release candidate and after changes to shared tokens, layout recipes, navigation, or modal primitives. Capture the routes below at 1280 × 800 and 430 × 900 in both light and dark themes. Review the rendered screenshots at normal size; do not treat screenshot capture or axe as visual approval.

Run the `visual-review` project against an already-running local-login container. It creates owner-scoped tasks, a block, an objective, a staged task, and direction/category/intention tags, then removes those fixtures after capture.

```sh
LOGIN_USER=<local-user> LOGIN_PASS=<local-password> \
APP_URL=http://localhost:8080 \
UI_REVIEW_DIR=test-results/ui-surface-review/<commit> \
pnpm --dir tests/container test:visual-review
```

The test captures 18 authenticated route/tab states, three public authentication states, and explicit Task Details and Flight Plan states. That produces 92 images across two themes and two viewports. `UI_REVIEW_DIR` can point to a release artifact directory; otherwise Playwright saves into its test output folder.

| Route surface | States to include |
|---|---|
| Today / Planner | Populated day, Flight Plan drawer; capture Details drawer when its surface changes |
| Focus | Default route; date picker and Focus Lab in the focused surface review when changed |
| Calendar | Populated calendar route; filters and Plan my week in the focused surface review when changed |
| Tasks | Tasks, Objectives, and Routines tabs; seeded normal/staged tasks; explicit Task Details state. Capture editor and bulk review when changed |
| Tags | Directions and Time Block Categories tabs with seeded tag groups and chips; capture tag editor when changed |
| Priorities | Default list and priority changes |
| Balance | Default metrics; review category and empty states when changed |
| Settings | Preferences, Profile, Learning, Connections, People, Logs, Privacy |
| Jobs | Current populated job list; job details when changed |
| Authentication | Login, Signup, and the reset-password route state |

Record the commit, browser, viewport, themes, routes reviewed, and any follow-up in the release checklist. Check clipping, overflow, text wrapping, focus visibility, selected/disabled states, contrast, and reachable actions.

## Manual device checks

Before a mobile-focused release, check at least one current iPhone with Safari and VoiceOver, and one Android device with Chrome and TalkBack. On both devices, verify:

- Dialog and sheet names, headings, control labels, reading order, and announcements after opening or changing tabs.
- Focus entry, keyboard or assistive-technology traversal, close/Escape behavior where available, and focus return without landing behind an open surface.
- Software keyboard resizing, field visibility, scroll behavior, browser chrome changes, and portrait/landscape transitions.
- Touch target reachability, text enlargement, zoom, reduced motion, and both themes.

Record device model, OS/browser versions, assistive technology, date, commit, pass/fail, and a concise defect note. Automated Chromium viewport checks do not replace these physical-device checks.

## 2026-11-25 release review

- Build from working tree based on `ebc3255b`. Captured 160 screenshots in Chromium 148.0.7778.96 at 1280 × 800 and 430 × 900, in light and dark themes. The sweep covered Today/Planner, Focus, Calendar, Tasks, Tags, Priorities, Balance, Settings, Jobs, and authentication. Used an isolated SQLite instance with seeded task, block, category, and tag records. The empty Jobs list used an empty API fixture. The reset form used a placeholder token for layout review.
- Reviewed the route matrix in contact sheets and inspected selected captures at full size. The screenshot sweep identified three issues to address before visual sign-off.
  - On Tasks, a staged card's reduced opacity exposes the Flight Plan, Archive, and Delete controls beneath the unswiped row. The underlying labels overlap the title at both widths and in both themes. See `tasks-tasks.png`.
  - On Settings → Logs at 430 × 900, the planning-session log header extends beyond the viewport and clips the `Clear all` action in both themes. See `settings-logs.png`.
  - On Tags at 430 × 900, the floating assistant button overlaps the trailing controls on a tag chip when the chip lines up with the button. See `tags-editor.png`.
- Playwright passed 29 checks across Tasks, Responsive, and Accessibility. The new Tasks journey uses Chromium touch input, reloads, and checks persisted Flight Plan, Archived, and Thrown away state through both the UI and API. Delete is a soft delete in this flow.
- Physical iPhone/Safari/VoiceOver and Android/Chrome/TalkBack checks are pending. There was no physical device available in this session. Record device model, software versions, date, build, and the checklist results above after testing each device.

## 2026-11-27 release review

- Built the client from the working tree based on `ebc3255b`. The local container gate passed all 48 browser checks, including 14 accessibility tests. The separate `visual-review` project passed and captured 92 images for 23 surface states at 1280 × 800 and 430 × 900 in light and dark themes. Its owner-scoped tasks, block, objective, staged task, and tags were cleaned up after the capture.
- Reviewed all four contact sheets and inspected phone captures at full size. The review found and fixed the three previously recorded layout problems: Settings → Logs now stacks its action row on narrow screens; staged task cards no longer expose their swipe actions under the dimmed row; and the Tags route docks the two floating actions on phone widths unless the user already saved a docking preference.
- Contact sheets: [light desktop](../test-results/ui-surface-review-2026-11-27/contact-sheets/light-desktop-1280x800.png), [dark desktop](../test-results/ui-surface-review-2026-11-27/contact-sheets/dark-desktop-1280x800.png), [light phone](../test-results/ui-surface-review-2026-11-27/contact-sheets/light-phone-430x900.png), [dark phone](../test-results/ui-surface-review-2026-11-27/contact-sheets/dark-phone-430x900.png). Individual route captures are under `test-results/ui-surface-review-2026-11-27/{light,dark}/{desktop-1280x800,phone-430x900}/`.
- Physical iPhone/Safari/VoiceOver and Android/Chrome/TalkBack checks remain pending. No attached device or simulator tooling (`adb`/`xcrun`) was available, so record device model, software versions, date, commit, and checklist results when those checks are performed.
