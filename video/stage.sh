#!/usr/bin/env bash
#
# Companion Planning — capture stage.
#
# Brings a throwaway database from empty to the exact state the committed shots
# were filmed against, boots the dev server, and leaves it running for
# `ci-video capture`.
#
# This file exists because there was no capture recipe: the shots were committed
# in #485 and re-shot by hand every time, with the steps living in README.md as
# prose that a human had to paste into a shell. `tools/stages.json` in
# CI-Engineering recorded `"capture": null` for this product as a result. The
# steps below are that prose, executed.
#
# ── Usage ────────────────────────────────────────────────────────────────────
#
#   ./stage.sh              # migrate + seed + boot + stage data; leaves server up
#   ./stage.sh --data-only  # staging API calls only, against an already-running server
#   ./stage.sh --stop       # stop a server this script started
#
# Then, from this directory:
#
#   APP_URL=http://localhost:$VITE_PORT \
#     node ../../CI-Common/packages/video-kit/bin/ci-video.mjs capture
#
# ── Overridable env (defaults chosen to not collide with a dev box) ──────────
#
#   DB_PATH     throwaway sqlite file. WIPED — never point this at real data.
#   PORT        server port                (default 3871)
#   VITE_PORT   client port                (default 5191)
#
# ── Why each pin is here ─────────────────────────────────────────────────────
#
#   GOOGLE_MODE=fixture   serve the committed calendar/email fixtures.
#   OLLAMA_URL=127.0.0.1:1  a CLOSED port. Every LLM path then takes its
#                         deterministic fallback. Without this the quick-add
#                         parse in `add-element-parsed` varies with whichever
#                         Ollama tag happens to be installed on the machine —
#                         and this box does run a live Ollama on :11434.
#   CP_FIXED_NOW          the same instant capture.config.mjs freezes the
#                         BROWSER to. The quick-add parse runs SERVER-side, so
#                         without this the shot films a date off the wall clock
#                         and contradicts the film's own frozen day.
#
# The frozen day (2026-06-03, a Wednesday) is inside the calendar fixture's
# window (2026-05-29 .. 2026-06-06). Change one and you must change the other,
# or Today renders its empty-state branch under narration about a cockpit.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd .. && pwd)"

DB_PATH="${DB_PATH:-/tmp/ci-planning-video.db}"
PORT="${PORT:-3871}"
VITE_PORT="${VITE_PORT:-5191}"
FIXED_NOW="${CP_FIXED_NOW:-2026-06-03T11:20:00Z}"
SEED_TARGET="${SEED_TARGET:-50}"

export DB_PATH PORT VITE_PORT
export GOOGLE_MODE=fixture
export OLLAMA_URL=http://127.0.0.1:1
export CP_FIXED_NOW="$FIXED_NOW"
export VITE_API_TARGET="http://localhost:$PORT"

API="http://localhost:$PORT/api"
JSON='content-type: application/json'
DAY='{"date":"2026-06-03"}'
# Runtime artifacts live beside the throwaway DB, NOT in the repo: video/build/
# and video/node_modules/ are gitignored but the repo root is not, and a stray
# .pid/.log there shows up as untracked noise in everyone else's `git status`.
PIDFILE="${DB_PATH}.stage.pid"
LOGFILE="${STAGE_LOG:-${DB_PATH}.stage.log}"

MODE="${1:-full}"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# `pnpm dev` runs `concurrently`, which forks the server and the client as
# grandchildren. Killing the recorded pid alone orphans both and leaves :PORT
# bound, so walk the tree. `setsid`/`kill -PGID` would be tidier but setsid is
# not on macOS, and this script has to run on the machine the shots come from.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

stop_server() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
      echo "stopped stage server (pid $pid and descendants)"
    fi
    rm -f "$PIDFILE"
  else
    echo "no pidfile at $PIDFILE — nothing this script started"
  fi
}

if [ "$MODE" = "--stop" ]; then stop_server; exit 0; fi

need() { command -v "$1" >/dev/null || { echo "missing required tool: $1" >&2; exit 1; }; }
need curl; need jq; need python3

# ─────────────────────────────────────────────────────────────────────────────
# 1. Database + seed
# ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" != "--data-only" ]; then
  say "seed  (DB_PATH=$DB_PATH — this file is WIPED)"
  rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
  ( cd "$REPO_ROOT" && pnpm --filter server migrate >/dev/null )

  # --no-llm    : without it the seeder mines the fixtures with a model and two
  #               runs produce different task titles — a phantom "UI drift" PR.
  # --target=50 : the fixtures promote exactly 50 real tasks. The default 100
  #               makes the seeder top up with 50 filler rows that land straight
  #               in the Tasks backlog and the auto-fill candidate pool.
  # --reset     : DESTRUCTIVE across all owners. Throwaway DB_PATH only.
  ( cd "$REPO_ROOT" && pnpm --filter server seed -- --no-llm --reset --target="$SEED_TARGET" 2>&1 ) \
    | grep -E 'TOTAL TASKS|Filler added|Meeting blocks|Tasks promoted' || true

  say "boot  (server :$PORT, client :$VITE_PORT)"
  # stdin from /dev/null and both output fds to the log, so the dev server holds
  # NO end of this script's own stdout. Without that, `./stage.sh | tail` hangs
  # forever after the script itself has finished: the pipe stays open as long as
  # a background descendant can still write to it.
  ( cd "$REPO_ROOT" && nohup pnpm dev </dev/null >"$LOGFILE" 2>&1 & echo $! > "$PIDFILE" )
  trap 'echo; echo "stage.sh failed — server left running for inspection: $LOGFILE"' ERR
fi

say "wait for the stage"
for i in $(seq 1 90); do
  s=$(curl -s -o /dev/null -w '%{http_code}' "$API/tasks" || true)
  c=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$VITE_PORT/" || true)
  [ "$s" = "200" ] && [ "$c" = "200" ] && break
  sleep 1
done
[ "$s" = "200" ] && [ "$c" = "200" ] || { echo "stage did not come up (server=$s client=$c). See $LOGFILE" >&2; exit 1; }
echo "server=$s client=$c"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Staging
#
# The seeder fills the BACKLOG and nothing else, so Today's Planner, Today's
# Flight-plan, Focus, /balance, /tags and the Objectives tab all render their
# empty-state branches. Every one of those shots waits on a selector that
# matches in the empty state too, so without this block the capture goes GREEN
# and films an empty product. That is exactly how thin coverage went unnoticed.
#
# Order is load-bearing in two places, both marked below.
# ─────────────────────────────────────────────────────────────────────────────
say "stage: priorities + flight plan"
curl -fsS -XPOST "$API/priorities" -H "$JSON" -d '{"priorities":[
  {"category":"health","satisfaction":5,"importance":8,"target_hours_per_week":10},
  {"category":"career","satisfaction":7,"importance":9,"target_hours_per_week":40},
  {"category":"relationships","satisfaction":6,"importance":9,"target_hours_per_week":15},
  {"category":"growth","satisfaction":4,"importance":7,"target_hours_per_week":10},
  {"category":"leisure","satisfaction":3,"importance":6,"target_hours_per_week":15},
  {"category":"finance","satisfaction":6,"importance":7,"target_hours_per_week":5}]}' >/dev/null

# ORDER 1/2: auto/fill must run BEFORE the rest-of-month blocks exist at the
# bottom of this file, or the fill sees them and places tasks around them.
curl -fsS -XPOST "$API/auto/fill" -H "$JSON" -d "$DAY" >/dev/null
curl -fsS -XPOST "$API/auto/run"  -H "$JSON" -d "$DAY" >/dev/null
curl -fsS -XPOST "$API/auto/fill" -H "$JSON" -d "$DAY" >/dev/null   # auto/run drains the flight plan

say "stage: objectives"
# seed-test-data.ts creates NO objectives, so /tasks?tab=objectives — the
# `objectives-tree` shot — films an empty panel without this.
# `level` is not settable: services/objectives.ts restamps goal/project/objective
# from tree height, so the three levels come from the parent chain.
# `category_id` is a tags(id) FK (migration 0081), not a Balance category key.
obj() { curl -fsS -XPOST "$API/objectives" -H "$JSON" -d "$1" | jq -r .objective.id; }

G1=$(obj '{"title":"Ship Companion Planning 1.0","horizon":"year","priority":1}')
P1=$(obj "{\"title\":\"Beta on the Hub market\",\"parent_id\":\"$G1\",\"horizon\":\"quarter\",\"priority\":1}")
O1=$(obj "{\"title\":\"Close the first-run punch list\",\"parent_id\":\"$P1\",\"horizon\":\"month\",\"priority\":2}")
O2=$(obj "{\"title\":\"Publish the app-store listing\",\"parent_id\":\"$P1\",\"horizon\":\"month\",\"priority\":3}")

G2=$(obj '{"title":"Ten hours a week outdoors","horizon":"year","priority":2}')
P2=$(obj "{\"title\":\"Ride Tuesdays and Thursdays\",\"parent_id\":\"$G2\",\"horizon\":\"quarter\",\"priority\":2}")
O3=$(obj "{\"title\":\"Book the spring route\",\"parent_id\":\"$P2\",\"horizon\":\"month\",\"priority\":3}")

# Task lookup by exact seeded title. Under --no-llm every title comes straight
# from server/test/fixtures/tasks.md, so these strings are stable across seeds;
# the ids are uuid7 and are not.
TASKS=$(curl -fsS "$API/tasks")
tsk() { echo "$TASKS" | jq -r --arg t "$1" '.tasks[] | select(.title==$t) | .id' | head -1; }

say "stage: balance categories"
# NOTHING assigns these without a model: services/task-enrich.ts is the only
# writer, it needs Ollama + memory, and it degrades to a silent no-op by design
# rather than guessing. With OLLAMA_URL pinned at a closed port all six Core
# Dimensions on /balance read "0 open" and the `balance-index` shot films the
# screen's own argument with the connection empty.
setcat() { curl -fsS -XPATCH "$API/tasks/$(tsk "$1")" -H "$JSON" -d "{\"categories\":$2}" >/dev/null; }
setcat "Schedule the annual physical and fill out the intake form" '["health"]'
setcat "Fix the leaking kitchen faucet or call a plumber"          '["health"]'
setcat "Ship the auto-scheduler reactive reflow behind a flag"     '["career"]'
setcat "Write integration tests for the block engine"              '["career"]'
setcat "Triage the GitHub issue backlog and label everything"      '["career"]'
setcat "Draft the API rate-limit policy for partners"              '["career"]'
setcat "Call Dad for his birthday and order the cake"              '["relationships"]'
setcat "Book the family dinner reservation"                        '["relationships","leisure"]'
setcat "Confirm the AIDevCon talk title and abstract"              '["growth","career"]'
setcat "Spike sqlite-vec for the dedupe pipeline"                  '["growth"]'
setcat "Renew passport before it expires in August"                '["leisure"]'
setcat "Reconcile the May capital account statements"              '["finance"]'
setcat "Categorize May credit-card transactions"                   '["finance"]'
setcat "Update the cap table with the new SAFE"                    '["finance"]'

say "stage: objective <-> task links"
# An objective with no linked task has progress_cache = NULL, which the panel
# renders as "No plan yet" with a dashed empty track — on all seven nodes at
# once. Tasks link to LEAF objectives only (heightBelow > 0 is a 422). A link
# alone gives 0%, so some linked tasks are also closed: the rollup is
# estimate-weighted and completed work is what makes the bars read as progress.
link() { curl -fsS -XPOST "$API/objectives/$1/tasks" -H "$JSON" -d "{\"task_id\":\"$(tsk "$2")\"}" >/dev/null; }
close() { curl -fsS -XPATCH "$API/tasks/$(tsk "$1")" -H "$JSON" -d '{"status":"done"}' >/dev/null; }

link "$O1" "Ship the auto-scheduler reactive reflow behind a flag"
link "$O1" "Write integration tests for the block engine"
link "$O1" "Triage the GitHub issue backlog and label everything"
close "Write integration tests for the block engine"

link "$O2" "Send Framework the SVG logo and 50-word blurb"
link "$O2" "Upload the Techstars pitch deck and founder video"
close "Send Framework the SVG logo and 50-word blurb"

# ORDER 2/2: the outdoors goal has no backlog behind it — tasks.md is a work
# brain-dump — so its leaf gets two tasks of its own. These are created AFTER
# `TASKS` was captured above, so they are referenced by the id the POST returns
# rather than through `tsk`.
newt() { curl -fsS -XPOST "$API/tasks" -H "$JSON" -d "$1" | jq -r '.task.id // .id'; }
T1=$(newt '{"title":"Map the Skyline loop and book the campsite","estimated_minutes":45,"priority":2,"categories":["leisure","health"]}')
T2=$(newt '{"title":"Service the bike before the first long ride","estimated_minutes":60,"priority":3,"categories":["health"]}')
curl -fsS -XPOST "$API/objectives/$O3/tasks" -H "$JSON" -d "{\"task_id\":\"$T1\"}" >/dev/null
curl -fsS -XPOST "$API/objectives/$O3/tasks" -H "$JSON" -d "{\"task_id\":\"$T2\"}" >/dev/null
curl -fsS -XPATCH "$API/tasks/$T2" -H "$JSON" -d '{"status":"done"}' >/dev/null

say "stage: tags"
# The seeder files every intention tag under nothing, so /tags renders HOME,
# WORK and COMMUNITY all reading "No tags yet." with a single UNSORTED card
# carrying all six. `directions` takes direction NAMES, not ids (services/tags.ts
# -> directionIds); ids are uuid7 and change every seed, so resolve by name.
TAGS=$(curl -fsS "$API/tags")
tid() { echo "$TAGS" | jq -r --arg n "$1" '.tags[] | select(.name==$n and .kind=="intention") | .id'; }
file_tag() { curl -fsS -XPATCH "$API/tags/$(tid "$1")" -H "$JSON" -d "{\"directions\":[\"$2\"]}" >/dev/null; }
file_tag product work; file_tag bizdev work; file_tag investment work; file_tag partnerships work
file_tag personal home
file_tag submissions community

# ...and each tag's Balance category. The per-chip category <select> defaults to
# an em dash, so without this every tag reads "#product —" and the frame is a
# column of placeholders.
file_cat() { curl -fsS -XPATCH "$API/tags/$(tid "$1")" -H "$JSON" -d "{\"categories\":[\"$2\"]}" >/dev/null; }
file_cat product career;      file_cat bizdev career
file_cat partnerships career; file_cat investment finance
file_cat personal relationships
file_cat submissions growth

say "stage: rest-of-month commitments"
# LAST — auto/fill above must not see these. The calendar fixture is one week
# wide, so Month view renders June 8-30 as an empty grid, two thirds of the
# `calendar-month` frame. These are time blocks rather than fixture events ON
# PURPOSE: the seeder mines every fixture event into a "Prep for ..." task, so
# widening calendar.json would push the backlog past --target=50 and move every
# other shot. All fall outside the frozen day and the visible week.
mtg() { # mtg <YYYY-MM-DD> <HH:MM> <minutes> <title>
  local s e
  s=$(python3 -c "import datetime;print(datetime.datetime.fromisoformat('$1T$2:00+00:00').isoformat().replace('+00:00','Z'))")
  e=$(python3 -c "import datetime;print((datetime.datetime.fromisoformat('$1T$2:00+00:00')+datetime.timedelta(minutes=$3)).isoformat().replace('+00:00','Z'))")
  curl -fsS -XPOST "$API/blocks" -H "$JSON" \
    -d "{\"title\":\"$4\",\"block_kind\":\"meeting\",\"is_locked\":true,\"start_at\":\"$s\",\"end_at\":\"$e\"}" >/dev/null
}
mtg 2026-06-09 09:00 30 "LITA onboarding standup"
mtg 2026-06-09 15:00 60 "Rek data-schema review"
mtg 2026-06-10 11:00 45 "Kwaai MCP connector scope"
mtg 2026-06-11 09:30 60 "Mighty Capital IC follow-on"
mtg 2026-06-12 14:00 45 "AMD co-marketing sync"
mtg 2026-06-15 09:00 30 "LITA onboarding standup"
mtg 2026-06-16 13:00 90 "SBIR narrative working session"
mtg 2026-06-17 10:00 60 "InfoDip API contract review"
mtg 2026-06-18 16:00 45 "Framework partner check-in"
mtg 2026-06-19 11:00 60 "Q2 board prep"
mtg 2026-06-22 09:00 30 "LITA onboarding standup"
mtg 2026-06-23 14:30 60 "Minisforum BOM and pricing"
mtg 2026-06-24 10:00 45 "Techstars mentor session"
mtg 2026-06-25 15:00 60 "LP annual meeting planning"
mtg 2026-06-26 12:30 60 "Lunch with mentor"
mtg 2026-06-29 09:00 30 "LITA onboarding standup"
mtg 2026-06-30 10:00 90 "AIDevCon rehearsal"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Assert the stage instead of hoping. Every one of these was a shot that
#    captured green and empty at some point in this project's history.
# ─────────────────────────────────────────────────────────────────────────────
say "verify"
fail=0
chk() { # chk <label> <actual> <expected>
  if [ "$2" = "$3" ]; then printf '  ok    %-34s %s\n' "$1" "$2"
  else printf '  FAIL  %-34s got %s want %s\n' "$1" "$2" "$3"; fail=1; fi
}

# GET /api/objectives returns a nested TREE (each node carries `children`), not a
# flat array — `.objectives|length` counts ROOTS ONLY and reads 2 on a correctly
# staged database. Recurse.
OBJ=$(curl -fsS "$API/objectives")
nodes() { echo "$OBJ" | jq "[.objectives|..|objects|select(has(\"level\"))]|$1"; }
chk "objectives total"          "$(nodes 'length')" 7
# NULL progress_cache is what renders "No plan yet" with a dashed empty track.
chk "objectives with progress"  "$(nodes '[.[]|select(.progress_cache!=null)]|length')" 7

# /balance has no endpoint of its own: views/Balance.tsx derives each dimension's
# "N open" client-side from the tasks store (the categories join). So assert the
# same join here rather than a route that does not exist.
chk "balance dims with an open task" \
  "$(curl -fsS "$API/tasks" | jq '[.tasks[]
       | select(.status as $s | ["open","scheduled","in_progress"] | index($s))
       | (.categories // [])[]]
       | map(select(. as $c | ["health","career","relationships","growth","leisure","finance"] | index($c)))
       | unique | length')" 6

chk "intention tags with a direction" \
  "$(curl -fsS "$API/tags" | jq '[.tags[]|select(.kind=="intention" and ((.directions//[])|length)>0)]|length')" 6
chk "intention tags with a category" \
  "$(curl -fsS "$API/tags" | jq '[.tags[]|select(.kind=="intention" and ((.categories//[])|length)>0)]|length')" 6
chk "flight plan populated" \
  "$(curl -fsS "$API/flight-plan" | jq '(.flight_plan//[])|length>0')" true
chk "rest-of-month blocks" \
  "$(curl -fsS "$API/blocks?from=2026-06-08T00:00:00Z&to=2026-07-01T00:00:00Z" | jq '.blocks|length')" 17

if [ "$fail" = 1 ]; then
  echo
  echo "STAGE INCOMPLETE — do not capture. A shot whose waitFor matches the empty" >&2
  echo "state will go green and film an empty product." >&2
  exit 1
fi

cat <<EOF

Stage ready.

  app        http://localhost:$VITE_PORT
  api        $API
  db         $DB_PATH
  frozen now $FIXED_NOW
  server log $LOGFILE

Capture (Playwright must resolve to EXACTLY the pin in package.json):

  APP_URL=http://localhost:$VITE_PORT \\
    node ../../CI-Common/packages/video-kit/bin/ci-video.mjs capture

Stop the server with:  ./stage.sh --stop

NOTE: this block is re-runnable only against a fresh seed. POST /api/objectives
has no upsert, so running --data-only twice gives you two of every goal.
EOF
