# Companion Planning — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Planning's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

**Videos are built locally, on demand, and are not stored.** There is no GitHub Actions job, no
uploaded artifact, no committed `.mp4`. A cut is a build output: make one when you need it, then
delete it. The screenshots under `assets/shots/` are meant to stay in git — they are the *input*
that lets anyone render without booting the app.

> **All 32 shots (16 × two viewports) are captured and committed** as of 2026-08-05, against the
> stage below. `ci-video status` reports `missing none`. Re-shoot with `npm run capture` whenever
> the UI moves, and commit the new PNGs in the PR that moved it.

## Quick start

The one command, from a CI-Engineering checkout (`tools/make-videos.mjs`):

```bash
node tools/make-videos.mjs --list                 # every product, and how many screens each has
node tools/make-videos.mjs companion-planning     # both cuts, rendered from the committed shots
```

It runs `ci-video` straight out of the CI-Common checkout on disk, so there is no registry, no
token and no authentication step. Output lands in `~/Movies/CI-Product-Videos/companion-planning/`,
outside every repo. It needs `ffmpeg`/`ffprobe` on `PATH` and Node 22+.

`--capture` (re-shoot the screens before rendering) is **not yet wired for this product** — the
runner has no stage entry for Companion Planning, so it falls back to render-only. To refresh the
shots, boot the stage and run the capture by hand from this directory:

```bash
npm install
npx playwright install --with-deps chromium
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the app's dev server running (see "The stage" below):
npm run capture       # drive the real UI -> assets/shots/*.png (both viewports)
npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-planning-landscape.mp4 and out/ci-planning-portrait.mp4
```

`npm install` here needs a GitHub Packages token, because `package.json` lists the private
`@companionintelligence/video-kit`. **Capture does not use that package** — it only needs
Playwright, which the kit resolves from this directory. To capture without a token, install
Playwright alone against a throwaway manifest and put the real one back:

```bash
cp package.json package.json.real
printf '{"name":"cap","private":true,"type":"module","devDependencies":{"playwright":"^1.58.0"}}' > package.json
npm install --no-package-lock
mv package.json.real package.json && rm -f package-lock.json
```

Then run the kit straight off disk, skipping the `npm run …` wrappers entirely:

```bash
APP_URL=http://localhost:5183 node ../../CI-Common/packages/video-kit/bin/ci-video.mjs capture
node ../../CI-Common/packages/video-kit/bin/ci-video.mjs status    # expect "missing none"
```

Chromium comes from `~/Library/Caches/ms-playwright`, so no browser download is needed if any
other product's capture has run on this machine. `video/node_modules/` is gitignored; never commit
`package.json.capture` or a lockfile.

## The stage

Capture runs against **source**, not the published container: `Dockerfile` sets
`NODE_ENV=production` and `server/src/lib/config.ts:403` refuses to boot with `AUTH_MODE=test`
there, while `docker-compose.yml` pins `AUTH_MODE=sso` — either way a login wall lands in front
of every shot. From source, `AUTH_MODE` defaults to `test` and `client/src/App.tsx` renders
`UngatedRouter`, so there is no login and no `storageState` to manage.

From the repo root:

```bash
export DB_PATH=/tmp/ci-planning-video.db   # throwaway — the seed below is destructive
export GOOGLE_MODE=fixture                 # sample data; refused in production, fine in dev
export OLLAMA_URL=http://127.0.0.1:1       # closed port -> every LLM path takes its fallback
export CP_FIXED_NOW=2026-06-03T18:20:00Z   # same instant capture.config.mjs freezes the browser to
corepack enable && pnpm install
pnpm --filter server migrate
pnpm --filter server seed -- --no-llm --reset --target=50
pnpm dev                                   # client vite :5173, server tsx :3848
```

Both flags on that seed line are load-bearing:

- `--no-llm` — without it the seeder mines the fixtures with Ollama and two runs produce
  different task titles, which shows up later as a phantom "UI drift" PR.
- `--target=50` — the fixtures promote exactly 50 real tasks. The default target of 100 makes the
  seeder top up the difference with 50 rows literally titled `Follow-up task 1 … 50`
  (`seed-test-data.ts` step 5). Those are placeholder filler, and they land in the Tasks backlog
  and the auto-fill candidate pool — i.e. straight into the frame. Ask for 50 and the filler
  branch never runs.

To run the stage on other ports (six agents share this machine): `VITE_PORT=5183`,
`PORT=3849`, `VITE_API_TARGET=http://localhost:3849`, then capture with
`APP_URL=http://localhost:5183`.

### Staging — run this before `npm run capture`

The seeder fills the **backlog** and nothing else, so Today's Planner, Today's Flight-plan,
Focus, `/balance` and the Objectives tab all render their empty-state branches. Every one of
those shots waits on a selector that matches in the empty state too, so they capture **green**
and film an empty product — which is exactly how thin coverage went unnoticed. Nothing runs these
for you: paste them into a shell once the dev server is up, before `npm run capture`.

```bash
API=http://localhost:3848/api; JSON='content-type: application/json'; DAY='{"date":"2026-06-03"}'

curl -fsS -XPOST "$API/priorities" -H "$JSON" -d '{"priorities":[
  {"category":"health","satisfaction":5,"importance":8,"target_hours_per_week":10},
  {"category":"career","satisfaction":7,"importance":9,"target_hours_per_week":40},
  {"category":"relationships","satisfaction":6,"importance":9,"target_hours_per_week":15},
  {"category":"growth","satisfaction":4,"importance":7,"target_hours_per_week":10},
  {"category":"leisure","satisfaction":3,"importance":6,"target_hours_per_week":15},
  {"category":"finance","satisfaction":6,"importance":7,"target_hours_per_week":5}]}'

curl -fsS -XPOST "$API/auto/fill" -H "$JSON" -d "$DAY"
curl -fsS -XPOST "$API/auto/run"  -H "$JSON" -d "$DAY"
curl -fsS -XPOST "$API/auto/fill" -H "$JSON" -d "$DAY"   # re-stage: auto/run drains the flight plan

# Objectives (needs jq). server/src/scripts/seed-test-data.ts creates none, so
# /tasks?tab=objectives — the `objectives-tree` shot, and the screen the "The long game"
# chapter is named after — films an empty panel without this. `level` is not settable:
# services/objectives.ts restamps goal/project/objective from tree height, so the three
# levels come from the parent chain. `category_id` is a tags(id) FK (migration 0081), not
# a Balance category key — leave it out.
obj() { curl -fsS -XPOST "$API/objectives" -H "$JSON" -d "$1" | jq -r .objective.id; }

G1=$(obj '{"title":"Ship Companion Planning 1.0","horizon":"year","priority":1}')
P1=$(obj "{\"title\":\"Beta on the Hub market\",\"parent_id\":\"$G1\",\"horizon\":\"quarter\",\"priority\":1}")
obj "{\"title\":\"Close the first-run punch list\",\"parent_id\":\"$P1\",\"horizon\":\"month\",\"priority\":2}" >/dev/null
obj "{\"title\":\"Publish the app-store listing\",\"parent_id\":\"$P1\",\"horizon\":\"month\",\"priority\":3}" >/dev/null

G2=$(obj '{"title":"Ten hours a week outdoors","horizon":"year","priority":2}')
P2=$(obj "{\"title\":\"Ride Tuesdays and Thursdays\",\"parent_id\":\"$G2\",\"horizon\":\"quarter\",\"priority\":2}")
obj "{\"title\":\"Book the spring route\",\"parent_id\":\"$P2\",\"horizon\":\"month\",\"priority\":3}" >/dev/null

# Tags. The seeder files every intention tag under nothing, so /tags — the `tags-taxonomy`
# shot, whose caption is "two axes of tags: direction, and intention" — renders HOME, WORK and
# COMMUNITY all reading "No tags yet." with a single UNSORTED card carrying all six. Filing them
# is what puts the second axis on screen. `directions` takes direction NAMES, not ids
# (services/tags.ts → directionIds), and ids are uuid7 so they change every seed — resolve by
# name, never paste an id.
TAGS=$(curl -fsS "$API/tags")
tid() { echo "$TAGS" | jq -r --arg n "$1" '.tags[] | select(.name==$n) | .id'; }
file_tag() { curl -fsS -XPATCH "$API/tags/$(tid "$1")" -H "$JSON" -d "{\"directions\":[\"$2\"]}" >/dev/null; }
file_tag product work; file_tag bizdev work; file_tag investment work; file_tag partnerships work
file_tag personal home
file_tag submissions community
```

Notes on why it is shaped that way:

1. **The date is not free.** `2026-06-03` is the day `capture.config.mjs` → `fixedTime` freezes
   the clock to, and it is inside the seeded fixture window (`server/test/fixtures/calendar.json`
   spans 2026-05-30 .. 2026-06-06). The client derives "today" from the frozen clock, so the two
   must agree. Change one and you must change the other. It also has to hold on the *server*
   side: the quick-add parse runs there (`routes/tasks.ts` → `parseQuick`), so without
   `CP_FIXED_NOW` exported alongside `pnpm dev` the `add-element-parsed` shot films a date taken
   from your wall clock and contradicts the film's own frozen day.
2. **No auth headers.** `requireAuth.ts:88-103` binds every `/api` call to `SYSTEM_OWNER` with
   all scopes under `AUTH_MODE=test` — the same owner the seeder writes as.
3. **Pin the model away.** Export `OLLAMA_URL=http://127.0.0.1:1` alongside `pnpm dev` so every
   LLM path takes its deterministic fallback. Without it the `add-element-parsed` shot's parse
   varies with whichever Ollama tag happens to be installed.
4. **Leave the first-run wizard alone.** Whether it appears is decided per-shot by the
   `/api/prefs` interceptor in `capture.config.mjs`, not by the database — so it does not
   matter whether you finished onboarding while staging.

Every determinism hazard found in the app source is written up at the top of
[`capture.config.mjs`](capture.config.mjs). Read it before changing a `waitFor` or a `mask`.

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, `npm run capture -- --only <id>`,
then `npm run build && npm run render`.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`assets/audio/*.mp3` **is** committed: 18 narration tracks, one per scene, regenerated from
`storyboard.json` with `npm run narrate` whenever a `narration` line changes.

`assets/shots/*.png` **is** committed on the same terms — 32 files, the record of what the product
looked like, byte-stable, so a diff in them means the UI genuinely changed. That is the fleet-wide
policy as of 2026-08-05: only a few products have a working stage, so a gitignored shot set means
nobody but the stage's author can render the cut. Nothing gitignores them here.

`ci-video build` substitutes a placeholder slate for a missing shot rather than failing, so a shot
that silently stops being captured is quiet — check `ci-video status` (expect `missing none`)
before trusting a cut.

The videos themselves are not kept anywhere. `out/` is gitignored, nothing uploads it, and no
scheduled job re-shoots the screens or opens a refresh PR — when the UI moves, run `npm run
capture` and commit the new shots in the PR that moved it.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.

## Why Playwright is pinned exactly

`video/package.json` pins `playwright` to an exact version, not a range.

Captures are byte-stable — that is what makes committing the shots worthwhile, because a UI change
then lands as a reviewable image diff instead of noise. But that property only holds **within one
Chromium build**. A `^1.58.0` range resolved to 1.62.1 on one machine and rewrote every committed
shot in a repo by 0.07–0.47% of pixels: pure text antialiasing, no layout change, and completely
indistinguishable from a real UI change in review.

So the range is gone. Re-pin deliberately when you want the newer browser, and re-capture the whole
shot set in the same commit.
