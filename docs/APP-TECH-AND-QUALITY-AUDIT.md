# Application technology and quality review

**Reviewed:** 2026-11-23

**Scope:** source-level architecture and test inventory, current Today/Planner cockpit screenshot, and a cross-component style review. No tests or coverage instrumentation were run for this review. The live screenshot showed the Today/Planner cockpit at a narrow 430 × 900 viewport with the Details / Flight Plan drawer expanded.

## 1. Major languages and frameworks

| Area | Language / framework | Where it is used |
|---|---|---|
| Web client | TypeScript, SolidJS, Solid Router | `client/src`; reactive SPA and route views |
| Styling | Tailwind CSS 4, app CSS, shared CI token package | `client/src/index.css`, `tailwind.config.js`; semantic theme tokens plus utility classes |
| Client build | Vite and `vite-plugin-solid` | Client development, production build, component test transform |
| Server | TypeScript, Node.js, Koa 3 | `server/src`; HTTP server, middleware, auth and static client serving |
| HTTP APIs | REST/Koa Router and GraphQL/Apollo Server | `server/src/routes`, `server/src/graphql`; both call shared services |
| Persistence | SQLite via `better-sqlite3` and Drizzle; PostgreSQL port adapter via `pg` | `server/src/db`; SQLite is the supported default backend. PostgreSQL work is incomplete and should not be treated as a production-ready alternate |
| Agents and integrations | TypeScript, MCP SDK, configurable LLM clients, Google connectors | `server/src/agents`, `server/src/mcp`, `server/src/connectors`; local Ollama and compatible configured providers |
| Mobile / desktop shells | Capacitor and Tauri | `mobile/`, `desktop/`; shells use the same web client and server APIs |
| Tests | Vitest, Solid Testing Library, jsdom, Playwright | Unit/component tests plus a small container/browser smoke suite |

## 2. Front end and back end

| Layer | Description | Main boundaries |
|---|---|---|
| Front end | A TypeScript/SolidJS single-page app. Major views include Today, Focus, Tasks, Calendar, Tags, Balance, Settings, Jobs, signup/login and reset-password. Shared components cover task cards, Planner, drawers, forms, notes and the task assistant. Reactive resources in the stores load API data; typed API helpers send writes; SSE refreshes cross-view state. | `client/src/App.tsx`, `client/src/views/`, `client/src/components/`, `client/src/stores/`, `client/src/lib/api.ts` |
| Back end | A Node/Koa application with authenticated owner-scoped REST routes and GraphQL resolvers. Services validate and coordinate writes; domain engines implement scheduling, recurrence, reflow, task lifecycle, objectives, metrics and learning. Croner runs scheduled jobs and agents. | `server/src/index.ts`, `server/src/routes/`, `server/src/graphql/`, `server/src/services/`, `server/src/engine/`, `server/src/jobs/` |
| Storage and external services | The Store facade abstracts database operations; SQLite/WAL is the default local store. PostgreSQL cutover remains incomplete. Optional integrations include Google Calendar/Gmail, email, push, memory services and configured LLM endpoints. These are conditional integrations, not a requirement for basic task CRUD. | `server/src/db/store.ts`, `server/src/db/schema.ts`, `server/src/connectors/`, `server/src/agents/`, [Postgres port status](../server/db/postgres/README.md) |

## 3. Mermaid diagrams

The living set of current diagrams is [DIAGRAMS.md](DIAGRAMS.md). It now includes the requested system, user, data, agent and metric flows. The diagrams distinguish actual writes from proposal/review steps and show the optional PostgreSQL and external service paths.

## 4. Test inventory and coverage

| Suite | Source inventory | What it covers | What the inventory does not prove |
|---|---:|---|---|
| Client unit and component | 139 `*.test.ts` / `*.test.tsx` files under `client/src`; Vitest has Node unit and jsdom/Solid DOM projects | Pure date, scheduling, task grouping, state, colors, parsing and metrics helpers; component rendering and interactions via Testing Library | No configured percentage threshold or measured line/branch coverage was found. File/test counts are not a coverage percentage. |
| Server unit and service | 297 `*.test.ts` files under `server/test`; Vitest uses an isolated SQLite database and fixture Google mode | Routes, services, engines, persistence, migration behavior and owner scoping; many suites use a real test database. Some model-backed tests are conditional on local LLM availability. | No configured percentage threshold or measured line/branch coverage was found. External live-provider behavior is not represented by fixture tests. |
| Browser / game-flow | `tests/container/` has a Playwright config and small container specs for service worker, headers, screenshot and login smoke flows | Container startup, selected auth modes, response headers, service worker and a screenshot smoke | This is not yet a broad authenticated user-flow suite for task editing, objective work, agent confirmations, scheduling conflicts, mobile layout or metrics recaps. |
| Cross-layer data flow | Currently spread through route/service/engine tests and a small number of Playwright smoke paths | Owner-scoped request → service → DB paths are tested in unit/integration-style server tests; selected client-to-container behavior is exercised in Playwright | There is no end-to-end matrix demonstrating every important write from browser gesture through persistence, SSE refresh and derived metric update. |

Repository counts are from a filename and test-call scan; they are a point-in-time inventory, not a run result. The client config uses separate `unit` and `dom` Vitest projects. The server config serializes files against a per-run SQLite database. No suite was run for this audit.

## 5. Playwright segmentation plan

| Project / phase | Flow | Main cases | Gate |
|---|---|---|---|
| `smoke` | App boot and navigation | App shell, route health, console/page errors, responsive shell | Every pull request |
| `auth` | Sign-in and session | Local login, portal login contract, logout/session expiry, signup/reset basic path | Pull request; fixture identities only |
| `tasks` | Create → edit → complete → note | Task form validation, timestamped notes, task list collapse/expand, archive/restore | Pull request |
| `planner` | Stage → schedule → inspect | Flight Plan selection, auto placement, adjacent tasks with no overlap, block edit/move, overlap-warning recovery, undo | Pull request; use deterministic seeded calendar data |
| `objectives` | Objective → add task → parent update | Parent prefill, clear parent to top-level, direct task add, status/progress update | Pull request |
| `agent` | Ask → clarify → review → confirm | Typed request, transcript review, proposal edit, confirm/edit/forget, tool failure and partial batch | Pull request with stubbed LLM; nightly one opt-in local-model scenario |
| `metrics` | Write → recap | Complete task/time entry/rating; verify Balance and agent read-only recap reflect persisted values | Pull request with fixed clock/seed |
| `responsive` | Core journeys at phone/tablet/desktop sizes | Modal bounds, keyboard viewport, no horizontal overflow, visible action targets, drawer and Planner interactions | Pull request on key flows; full viewport matrix nightly |
| `integrations` | Google, push, external model paths | Contract-level request/response and explicit mocked failures | Nightly or integration environment; no live account dependencies in standard CI |

Implementation sequence: (1) split the current container smoke suite into named Playwright projects and fixtures; (2) add deterministic owner/task/blocks API seed helpers and cleanup; (3) add task and Planner paths first because they cross the most layers; (4) add agent and metrics with mocked external providers; (5) run a focused mobile viewport matrix for every modal/drawer family; (6) publish screenshots and traces for failed CI cases. Use role/name locators and stable test IDs only where semantics are insufficient. Keep server rule tests in Vitest; use Playwright for browser behavior and cross-layer journeys rather than duplicating every edge case.

## 6. Front-end style audit and compartmentalization

### Inventory and observed style system

| Item | Finding |
|---|---|
| Surface size | 144 TSX files in `client/src/components/`, 18 TSX files in `client/src/views/`; 168 TSX files total across the client. |
| Shared visual foundation | `client/src/index.css` imports Tailwind and the CI token package, defines light/dark semantic CSS variables, global controls (`.btn-*`, `.input`, `.view-*`), navigation and drawer styles. Tailwind config maps legacy color names to semantic variables. |
| Component styling | Most layout and spacing are utility classes; feature views also include dynamic inline CSS for data-driven colors, widths and timeline placement. The original source scan found 122 `style=` occurrences; after the presentation cleanup it finds 106. Dynamic schedule geometry and data-selected colors remain inline. |
| Screenshot evidence | The current narrow Today/Planner cockpit keeps navigation and day controls visible. With the Details/Flight Plan drawer open, the drawer consumes most of the vertical viewport and leaves only a small slice of Planner visible; this is a high-value mobile-flow target for responsive testing. |

### Findings

| Priority | Finding | Recommendation |
|---|---|---|
| High | The app has shared semantic tokens and global primitives, but feature modules still compose many low-level utilities and hand-built action rows. Similar modal, card, header, toolbar and empty-state patterns can drift across the 144 shared components. | Define a small set of accessible, responsive primitives (PageHeader, Toolbar, Card, Modal/Sheet, FormField, EmptyState, ActionMenu, DataList) and migrate by feature slice. Avoid a wholesale rewrite. |
| High | Planner, Details drawer, Flight Plan and floating assistant compete for limited mobile canvas. The captured 430 × 900 state shows the drawer dominating the work area. | Establish a single mobile compartment model: one primary surface at a time, with drawers/sheets constrained to the visual viewport, explicit close/back affordances and preserved context when switching surfaces. Add viewport regression checks. |
| Medium | Inline styles still exist across features, but fixed visual treatments are now isolated in semantic classes and token-backed recipes; runtime geometry/color remains inline where it comes from schedule, task, or user data. | Continue the cleanup by feature slice when those components are next touched; avoid moving data-derived values into hard-coded classes. |
| Medium | Utility class strings encode component-specific spacing, typography, and states directly in JSX, so related controls can drift during iterative mobile fixes. | Adopt feature-level style recipes for recurring elements, e.g. Planner card actions and modal field grids. Document component contracts and responsive variants beside the shared primitive. |
| Medium | Contrast and touch-target quality cannot be fully judged from one screenshot or source scan; the app has custom light/dark tokens, but per-state accessibility needs automated checks. | Add axe checks to representative browser flows and verify keyboard focus, reduced-motion, text scaling, 44px touch targets and contrast in both themes. |

**Implementation status (2026-11-23):** `client/src/ui/` now provides shared PageHeader, Toolbar, Card, Modal/Sheet, FormField, EmptyState, ActionMenu and DataList primitives. Balance Metrics is the first migrated slice, using the shared header, control group, cards and empty states. Existing components in other features are intentionally left for later vertical-slice migrations; the primitives are a foundation, not a claim that all 144 components have already been migrated.

**Mobile compartment status (2026-11-23):** Details and Flight Plan now use one visual-viewport-bounded mobile sheet with a dimmed, non-interactive canvas, a preserving Back action, an explicit close-and-clear action, and a direct assistant switch. The sheet tracks `visualViewport`; the assistant is also viewport-anchored and remains mounted while closed so its draft conversation survives a surface switch. A 430 × 900 authenticated Playwright check is wired into the local-login container job. Broader route-specific screenshots and physical keyboard-device coverage remain future work.

**Inline style status (2026-11-23):** Repeated/static treatments for brand labels, approval outlines, onboarding backdrops, safe-area padding, icon strokes, star/day fills, chart markers, card outlines, animation delays, and wizard drag feedback now use shared CSS recipes backed by semantic tokens. Planner coordinates, progress widths, user-selected colors, and other data-driven values remain inline. The scan dropped from 122 to 106 occurrences; this is a targeted cleanup, not a claim that all feature styling has been centralized.

**Feature recipe status (2026-11-23):** `client/src/ui/recipes.css` documents the contracts and narrow-screen behavior for Planner action menus and modal form layouts. The Planner quick-action menu and Objective modal use those recipes: actions share alignment and hit-area rules, objective field pairs stack on mobile and form two columns at 40rem, and footer actions can share the available width on very narrow screens. Extend recipes by feature slice when adjacent controls are updated; keep content-specific visual states semantic on the control.

### Suggested web compartmentalization refactor

1. Keep domain boundaries in `views/` and `components/`; do not split solely by file size.
2. Add `client/src/ui/` for stable primitives and style recipes, without task/scheduling business logic.
3. Group feature composition under `client/src/features/{tasks,planner,objectives,focus,agent,metrics}/`, moving view-specific components with their view while preserving shared domain services in `lib/` and `stores/`.
4. Treat overlays as viewport-level compartments with one stacking contract, focus management, safe-area and keyboard handling.
5. Refactor in vertical slices: Planner/Flight Plan, task edit/detail, objectives, then Focus/metrics and Settings. Keep route behavior and store/API contracts unchanged in each slice.
6. After each slice, compare desktop/mobile screenshots and run the new Playwright project for that slice; use Vitest for isolated component logic.

### Audit limits

The visual review covers the captured Today/Planner shell state, not every route, modal, theme, or device. The source audit inventories all TSX files but is not a rendered review of every individual component. Browser accessibility checks, contrast measurements, keyboard-only navigation, and a full mobile/tablet/desktop screenshot matrix remain to be added to the Playwright plan above.
