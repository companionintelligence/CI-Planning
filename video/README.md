# Companion Planning — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Companion Planning's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

## Quick start

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
corepack enable && pnpm install
pnpm --filter server migrate
pnpm --filter server seed -- --no-llm --reset
pnpm dev                                   # client vite :5173, server tsx :3848
```

`--no-llm` matters: without it the seeder mines the fixtures with Ollama and two runs produce
different task titles, which shows up later as a phantom "UI drift" PR.

### Staging checklist — do this before `npm run capture`

The seeder fills the **backlog** and nothing else, so three screens are empty until a human
drives the app once. All three are visible in the video, so none of this is optional:

1. **Place a day.** Seeded tasks carry no `scheduled_for`, so Today's Planner and Flight-plan
   render empty. Open `/calendar`, press **Schedule**, or stage blocks by hand — on the same
   date the capture clock is frozen to (`capture.config.mjs` → `fixedTime`, default
   **2026-06-15**, a Monday). The client derives "today" from that frozen clock; if the
   database has nothing on that date, Today films an empty grid.
2. **Run the Priorities wizard once** (`/priorities`, three steps). Until it has been
   completed, `/balance` shows a "No priorities set yet" card instead of the Balance Index.
3. **Leave the first-run wizard alone.** Whether it appears is decided per-shot by the
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

`assets/shots/*.png` and `assets/audio/*.mp3` **are** committed — they are the record of what the
product looked like, and captures are byte-stable, so a diff in them means the UI genuinely
changed. `out/` is not committed.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
