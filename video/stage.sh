#!/usr/bin/env bash
#
# The capture stage for Companion Planning.
#
# Sourced by video/make.sh (the kit's runner), which expects stage_up and
# stage_down. Also runnable on its own for a capture driven by hand:
#
#   ./video/stage.sh up        bring it up and print APP_URL
#   ./video/stage.sh down      stop it
#
# It migrates a THROWAWAY SQLite database, seeds the committed fixture corpus,
# starts the Koa server and the Vite client, and then runs
# video/scripts/stage-data.sh — which is the part that was missing.
#
# ── THINGS THAT ARE LOAD-BEARING, AND WHY ────────────────────────────────────
#
# THE SEED ALONE DOES NOT PRODUCE THE FILMED STATE. It fills the backlog and
# nothing else, so Today, Focus, /balance, the Objectives tab and /tags all
# render empty-state branches — and every one of those shots waits on a selector
# that matches in the empty state too, so they capture GREEN. A shot of an empty
# "No plan yet" objectives tree shipped exactly that way. stage-data.sh is the
# rest of the state, and it asserts the result rather than assuming it.
#
# CAPTURE RUNS AGAINST SOURCE, NOT THE CONTAINER. Dockerfile sets
# NODE_ENV=production and server/src/lib/config.ts:403 refuses to boot with
# AUTH_MODE=test there, while docker-compose.yml pins AUTH_MODE=sso — either way
# a login wall lands in front of every shot. From source AUTH_MODE defaults to
# test and client/src/App.tsx renders UngatedRouter, so there is no login and no
# storageState to manage.
#
# GOOGLE_MODE=off, NOT fixture. scheduled_jobs runs ingest_gcal every 30 minutes
# and ingest_gmail every 15. In fixture mode they re-mine the same calendar.json
# the seed just read, through the PRODUCTION extraction path, which has no
# prepTaskTitle — so three more rows appear titled "Gym - leg day",
# "Lunch with mentor" and "Holiday - Office closed". Measured 2026-08-08: a stage
# seeded at 20:42 had 47 tasks; at 21:00:01 it had 50, and nothing in the capture
# log said so. Whether your shots contain those rows would depend on how long you
# took between staging and capturing, which is not a property a committed
# screenshot may have.
#
# OLLAMA_URL AT A CLOSED PORT. Every LLM path then takes its deterministic
# fallback. Without it the add-element-parsed shot's parse varies with whichever
# Ollama tag happens to be installed on the machine.
#
# CP_FIXED_NOW MUST MATCH capture.config.mjs's fixedTime. The quick-add parse
# runs on the SERVER (routes/tasks.ts -> parseQuick), so freezing only the
# browser clock leaves add-element-parsed filming a date from your wall clock,
# contradicting the film's own frozen day.
#
# --no-llm AND --target=47 ARE BOTH LOAD-BEARING. Without --no-llm the seeder
# mines the fixtures with Ollama and two runs produce different task titles.
# Without --target=47 the default of 100 tops up with 53 filler rows that land in
# the backlog and the auto-fill candidate pool — i.e. straight into frame.
#
# THIS RUNS pnpm install AND A DESTRUCTIVE SEED IN THE CHECKOUT IT LIVES IN.
# Use your own worktree. Six agents share this machine, so every port is a
# variable; the defaults below are the video stage's own, not the app's.
#
set -euo pipefail

_stage_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }

STAGE_WEB_PORT="${STAGE_WEB_PORT:-5183}"
STAGE_API_PORT="${STAGE_API_PORT:-3849}"
STAGE_DB_PATH="${STAGE_DB_PATH:-/tmp/ci-planning-video.db}"
STAGE_LOG="${STAGE_LOG:-$(mktemp -t ci-planning-stage)}"
export APP_URL="${APP_URL:-http://localhost:$STAGE_WEB_PORT}"

# The instant capture.config.mjs freezes the browser to. Server and browser must
# agree — see CP_FIXED_NOW above.
STAGE_FIXED_NOW="${STAGE_FIXED_NOW:-2026-06-03T11:20:00Z}"

_stage_env() {
  export DB_PATH="$STAGE_DB_PATH"
  export GOOGLE_MODE=off
  export OLLAMA_URL=http://127.0.0.1:1
  export CP_FIXED_NOW="$STAGE_FIXED_NOW"
  export PORT="$STAGE_API_PORT"
  export VITE_PORT="$STAGE_WEB_PORT"
  export VITE_API_TARGET="http://localhost:$STAGE_API_PORT"
}

_stage_wait() { # url, label
  for _ in $(seq 1 120); do
    curl -fsS -m 2 "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "stage: $2 never answered at $1" >&2
  tail -40 "$STAGE_LOG" >&2 || true
  return 1
}

# corepack, because package.json pins pnpm@11.5.3 and the machine's global pnpm
# is usually older. A mismatched pnpm resolves a different tree, and the frontend
# it builds is not the tree you checked out.
_pnpm() { corepack pnpm "$@"; }

stage_up() {
  local root; root="$(_stage_root)"
  _stage_env

  # CLEAR A LEAKED STAGE FIRST. A previous run that was interrupted between
  # stage_up and stage_down leaves the server holding 3849 — and then this run
  # migrates and seeds a FRESH database that the surviving server has never
  # opened, while every curl in stage-data.sh talks to the old one. Observed:
  # the seed reported 47 tasks into a new file, and stage-data.sh refused with
  # "objectives already exist" because the answering server still had the
  # previous run's. Nothing else in the chain would have noticed; it is only
  # visible because stage-data.sh checks before it writes.
  stage_down
  for _ in $(seq 1 10); do
    port_is_free "$STAGE_API_PORT" && port_is_free "$STAGE_WEB_PORT" && break
    sleep 1
  done
  port_is_free "$STAGE_API_PORT" || die "port $STAGE_API_PORT is still held after stage_down — another stage is running"
  port_is_free "$STAGE_WEB_PORT" || die "port $STAGE_WEB_PORT is still held after stage_down — another stage is running"

  # Start from an empty database. The seeder is only deterministic against one:
  # --reset drops and recreates, and the objectives POSTs in stage-data.sh have
  # no upsert, so a re-run on a populated database doubles every goal.
  rm -f "$STAGE_DB_PATH" "$STAGE_DB_PATH-shm" "$STAGE_DB_PATH-wal"

  ( cd "$root" && corepack enable >/dev/null 2>&1 || true )
  ( cd "$root" && _pnpm install --frozen-lockfile ) >>"$STAGE_LOG" 2>&1
  ( cd "$root" && _pnpm migrate )                   >>"$STAGE_LOG" 2>&1
  ( cd "$root" && _pnpm --filter server seed -- --no-llm --reset --target=47 ) >>"$STAGE_LOG" 2>&1

  # Detached with all three descriptors redirected. Leaving stdout inherited
  # looks harmless and is not: the children hold the write end of whatever pipe
  # the caller used, so `stage.sh up | tail` hangs forever on a stage that came
  # up perfectly.
  # The server survives `pnpm --filter server start` because that wrapper execs
  # into tsx rather than parenting it — measured, not assumed. Vite below does
  # not, and gets the binary directly.
  ( cd "$root" && nohup env \
      DB_PATH="$STAGE_DB_PATH" GOOGLE_MODE=off OLLAMA_URL=http://127.0.0.1:1 \
      CP_FIXED_NOW="$STAGE_FIXED_NOW" PORT="$STAGE_API_PORT" \
      corepack pnpm --filter server start >>"$STAGE_LOG" 2>&1 </dev/null & disown ) 2>/dev/null || true
  _stage_wait "http://localhost:$STAGE_API_PORT/api/tasks" "server"

  # The BINARY, not `pnpm exec vite`. pnpm exec spawns Vite as its own child and
  # does not survive being disowned here: the stage came up, Vite printed
  # "ready in 564 ms", and then exited with the wrapper — leaving the server on
  # 3849 and nothing on 5183. The only symptom was a stage_up that timed out
  # long after the log said everything had started.
  ( cd "$root/client" && nohup env \
      VITE_API_TARGET="http://localhost:$STAGE_API_PORT" \
      ./node_modules/.bin/vite --host 127.0.0.1 --port "$STAGE_WEB_PORT" --strictPort \
      >>"$STAGE_LOG" 2>&1 </dev/null & disown ) 2>/dev/null || true
  _stage_wait "http://localhost:$STAGE_WEB_PORT/" "vite"

  # THE STEP THAT WAS MISSING. Not optional, and it asserts its own result.
  bash "$root/video/scripts/stage-data.sh" "http://localhost:$STAGE_API_PORT/api"
}

stage_down() {
  # ANCHOR ON THE PORT, NOT ON THE COMMAND'S SPELLING. What stage_up launches is
  # `./node_modules/.bin/vite`, but what appears in the process table is
  #
  #     node ./node_modules/.bin/../vite/bin/vite.js --host 127.0.0.1 --port 5183 --strictPort
  #
  # so a pattern of "vite --host …" matches nothing — `vite.js` is not `vite`.
  # stage_down then returned 0 with the listener still up, and the next run's
  # port check refused a stage that looked, from every log line, fine. Matching
  # `vite.*--port <port>` covers both spellings and still cannot reach another
  # agent's stage, because the port is what makes it ours.
  pkill -f "vite.*--port $STAGE_WEB_PORT" 2>/dev/null || true
  # The server's command line carries neither a directory prefix nor the port:
  #   tsx --env-file-if-exists=.env src/index.ts
  # so anchoring on "server/src/index.ts" or on the port matches nothing. Match
  # what is actually there, then fall back to whatever still holds the port —
  # the port is the only thing that makes the process ours, and a stage_down
  # that returns 0 without freeing it is worse than one that fails.
  pkill -f "tsx --env-file-if-exists=.env src/index.ts" 2>/dev/null || true
  # `|| pid=""` is required, not defensive noise: lsof exits 1 when nothing
  # matches, and under `set -o pipefail` that status survives `| head -1` and
  # becomes the assignment's status, which `set -e` treats as fatal. In CI-Hub's
  # stage the identical line killed stage_up from inside stage_down with no
  # message at all.
  local pid
  pid="$(lsof -tnP -iTCP:"$STAGE_API_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)" || pid=""
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  return 0
}

# Standalone entry point. Sourcing the file defines the functions and does
# nothing else, which is what make.sh needs.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  # STANDALONE USE NEEDS THE HELPERS make.sh NORMALLY SUPPLIES. When this file is
  # sourced by the runner, say/warn/die/port_is_free/pick_port/kit are already
  # defined; run directly, they are not — and stage_up calls port_is_free and die
  # before it does anything else, so `./video/stage.sh up` died on
  # "port_is_free: command not found". The header documents this entry point, so
  # it has to work.
  command -v say          >/dev/null 2>&1 || say()  { printf "\n==> %s\n" "$*"; }
  command -v warn         >/dev/null 2>&1 || warn() { printf " ! %s\n" "$*" >&2; }
  command -v die          >/dev/null 2>&1 || die()  { printf "\n x %s\n" "$*" >&2; exit 1; }
  command -v port_is_free >/dev/null 2>&1 || port_is_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
  case "${1:-up}" in
    up)   stage_up; echo "stage up — APP_URL=$APP_URL (log: $STAGE_LOG)" ;;
    down) stage_down; echo "stage down" ;;
    *)    echo "usage: $0 [up|down]" >&2; exit 2 ;;
  esac
fi
