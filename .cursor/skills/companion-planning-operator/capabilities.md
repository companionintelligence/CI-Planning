# Companion Planning user-task map

Use this map to route a request. The visible app is authoritative if labels or layout have changed.

| User goal | Primary surface | Common actions |
|---|---|---|
| See or organize today's work | **Today** (`/`) | Change day, view due work, quick-add, filter directions, review capacity and open time, update focus, reflection/note, stars, and current-block ritual |
| Capture or manage work | **Tasks** (`/tasks`) | Add one or many tasks, search/filter/sort, edit details, complete, reschedule, archive/cancel, and review email suggestions |
| Plan time | **Calendar** (`/calendar`) | Day/week/month navigation, create or move blocks, inspect events, set overlays, schedule the selected day, export `.ics`, review, and open Plan my week |
| Work through current tasks | **Focus** (`/focus`) | Select a day, work with task cards and focus timers/rituals, inspect time blocks, and use the task/plan assistant when shown |
| Organize task taxonomy | **Tags** (`/tags`) | Rename and color direction/pattern tags and categories, choose icon/shape, reorder or remove tags |
| Build longer-term outcomes | **Objectives** tab/board (`/tasks?tab=objectives`, `?view=board`) | Create goal/project/objective hierarchy, attach tasks, add subtasks, inspect roll-up progress |
| Set life targets and review balance | **Life Balance** (`/balance`) and **Set up Life Balance** (`/priorities`) | Save satisfaction/focus/hour targets, inspect dimensions and history, open linked tasks |
| Configure the app | **Settings** (`/settings`) | Profile, preferences, people, connections, learning, logs, privacy, accounts, exports/imports, and date-range tools |
| Run or inspect automation | **Jobs** (`/jobs`) | Read job status/history and run an authorized job for the current account |
| Sign in or recover access | `/login`, `/signup`, `/reset-password` | Sign in, use configured signup/invitation flow, or complete a valid reset link |
| Connect the mobile shell | **Connect to your server** (Capacitor first run) | Enter the user's server address; the app probes health/auth config before saving it |

## Navigation notes

- Desktop sidebar exposes Focus, Today, Calendar, Tasks, Objectives board, Balance, Tags, Jobs, and Settings. On mobile, Jobs and other secondary pages are in **More**.
- Jobs can be hidden for non-operator users. Do not try to route around a permission denial.
- Objectives live under Tasks. `/objectives`, `/inbox`, and `/patterns` redirect to their current surfaces; do not treat them as separate active views.
- Settings has tabs: **Profile**, **Preferences**, **People**, **Connections**, **Learning**, **Logs**, and **Privacy**.
- Some content is inside drawers, dialogs, or tabs. Open the relevant control and inspect the resulting surface before assuming the action is unavailable.
- The mobile app's first-run server form is outside the web router. It stores a server address, not a password; sign-in happens afterward.

## User intents to translate

- “Put X on Tuesday at 2” means locate/create the task, resolve Tuesday in the app timezone, set the requested start intent, and verify its resulting task or block placement.
- “Make time for X” means inspect the calendar, availability, current commitments, and task estimate before placing it; avoid silently moving unrelated fixed events.
- “Clear/open my day” is not the same as deleting tasks or external calendar events. Clarify the intended schedule scope if the requested outcome is unclear.
- “I finished X” means complete the exact task and verify its status; do not infer completion of linked subtasks or series instances unless the UI does so.
- “Help me plan the week” can mean the Calendar **Plan my week** assistant, weekly goals in Today, or a week of calendar blocks. Choose from context or ask which outcome they want.

## Source references for keeping this guide current

- Route/auth shell and access gates: `client/src/App.tsx`
- Desktop/mobile navigation: `client/src/components/Nav.tsx`, `client/src/components/BottomNav.tsx`
- Client API names and request shapes: `client/src/lib/api.ts`
- Server route behavior and permission checks: `server/src/routes/`
- Product language and broader feature descriptions: `README.md`

If this guide and the live UI disagree, trust the visible UI for the current session and inspect the implementation/docs before attempting a fallback.
