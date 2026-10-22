#!/usr/bin/env bash
#
# Stage the data the FILM needs, on top of a freshly seeded database.
#
#   video/scripts/stage-data.sh [API_BASE]        default http://localhost:3848/api
#
# ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
#
# The seeder fills the BACKLOG and nothing else. Today's Planner, Today's
# Flight-plan, Focus, /balance, the Objectives tab and /tags all render their
# EMPTY-STATE branches against a bare seed — and every one of those shots waits
# on a selector that matches in the empty state too. So they capture green, exit
# 0, and film an empty product.
#
# That is not hypothetical: a shot of an empty "No plan yet" objectives tree
# shipped. The seeder was not wrong and the capture was not wrong; the state
# between them lived in video/README.md as a block of curl commands for a human
# to paste, and a step that only exists as prose is a step that is sometimes
# skipped.
#
# This is that block, executable, run by video/stage.sh. Editing it and editing
# the README are the same act now — the README points here.
#
# ── PRECONDITIONS, WHICH IT CHECKS ───────────────────────────────────────────
#
#   * a FRESH seed. POST /api/objectives has no upsert, so running this twice
#     gives you two of every goal. stage.sh re-seeds with --reset first.
#   * the server on $API, with AUTH_MODE=test (requireAuth.ts binds every /api
#     call to SYSTEM_OWNER, so there are no auth headers anywhere below).
#   * jq and python3.
#
set -euo pipefail

API="${1:-http://localhost:3848/api}"
JSON='content-type: application/json'
DAY='{"date":"2026-06-03"}'   # the day capture.config.mjs freezes the clock to

command -v jq      >/dev/null || { echo "stage-data: jq not found — 'brew install jq'" >&2; exit 1; }
command -v python3 >/dev/null || { echo "stage-data: python3 not found" >&2; exit 1; }
curl -fsS -m 5 "$API/tasks" >/dev/null || { echo "stage-data: no server at $API" >&2; exit 1; }

# Refuse a second run rather than silently doubling every goal. The failure this
# prevents is not a crash — it is seven duplicate objectives quietly on camera.
if [ "$(curl -fsS "$API/objectives" | jq '[.objectives | .. | objects | select(has("horizon"))] | length')" != "0" ]; then
  echo "stage-data: objectives already exist — this block is not idempotent." >&2
  echo "            Re-seed with --reset first (video/stage.sh does)." >&2
  exit 1
fi

say() { printf '  · %s\n' "$*"; }

# ── Balance priorities ───────────────────────────────────────────────────────
say "priorities"
curl -fsS -XPOST "$API/priorities" -H "$JSON" -d '{"priorities":[
  {"category":"health","satisfaction":5,"importance":8,"target_hours_per_week":10},
  {"category":"career","satisfaction":7,"importance":9,"target_hours_per_week":40},
  {"category":"relationships","satisfaction":6,"importance":9,"target_hours_per_week":15},
  {"category":"growth","satisfaction":4,"importance":7,"target_hours_per_week":10},
  {"category":"leisure","satisfaction":3,"importance":6,"target_hours_per_week":15},
  {"category":"finance","satisfaction":6,"importance":7,"target_hours_per_week":5}]}' >/dev/null

# ── Today ────────────────────────────────────────────────────────────────────
# auto/run drains the flight plan, so fill again after it. This must happen
# BEFORE the rest-of-month blocks exist or the fill sees them.
say "today: fill, run, re-fill"
curl -fsS -XPOST "$API/auto/fill" -H "$JSON" -d "$DAY" >/dev/null
curl -fsS -XPOST "$API/auto/run"  -H "$JSON" -d "$DAY" >/dev/null
curl -fsS -XPOST "$API/auto/fill" -H "$JSON" -d "$DAY" >/dev/null

# ── Objectives ───────────────────────────────────────────────────────────────
# `level` is not settable: services/objectives.ts restamps goal/project/objective
# from tree height, so the three levels come from the parent chain. `category_id`
# is a tags(id) FK (migration 0081), not a Balance category key — leave it out.
say "objectives"
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
tsk() {
  local id
  id=$(echo "$TASKS" | jq -r --arg t "$1" '.tasks[] | select(.title==$t) | .id' | head -1)
  [ -n "$id" ] && [ "$id" != "null" ] || { echo "stage-data: no seeded task titled \"$1\"" >&2; exit 1; }
  echo "$id"
}

# ── Balance categories ───────────────────────────────────────────────────────
# NOTHING assigns these without a model: services/task-enrich.ts is the only
# writer, it needs Ollama + memory, and it degrades to a silent no-op BY DESIGN
# rather than guessing. With OLLAMA_URL pinned at a closed port (stage.sh does)
# every Core Dimension on /balance would read "0 open" and balance-index would
# film the screen's own argument with the connection empty. Assign them here
# rather than teaching the app to guess.
say "balance categories"
setcat() { curl -fsS -XPATCH "$API/tasks/$(tsk "$1")" -H "$JSON" -d "{\"categories\":$2}" >/dev/null; }
# Titles are the SYNTHETIC fixture's (server/test/fixtures/tasks.md, #563) — exact
# strings, because tsk() matches on equality. A rename there has to land here too.
setcat "Bring the insurance card to the dentist"                       '["health"]'
setcat "Two hour volunteer slot at the repair cafe"                    '["health","leisure"]'
setcat "Ship the auto-scheduler reactive reflow behind a flag"         '["career"]'
setcat "Write integration tests for the block engine"                  '["career"]'
setcat "Triage the issue backlog and label everything"                 '["career"]'
setcat "Draft the API rate-limit policy for partners"                  '["career"]'
setcat "Pick up a card and a cake"                                     '["relationships"]'
setcat "Book the table for the family birthday dinner"                 '["relationships","leisure"]'
setcat "Drop the donation bags off on Saturday"                        '["relationships"]'
setcat "Upload the conference slides and confirm A/V requirements"     '["growth","career"]'
setcat "Spike a vector index for the dedupe pipeline"                  '["growth"]'
setcat "Categorize May transactions and gather the missing receipts"   '["finance"]'
setcat "Sign and return the insurance renewal documents"               '["finance"]'
setcat "Decide on the hosting plan before it renews"                   '["finance"]'

# ── Objective <-> task links ─────────────────────────────────────────────────
# An objective with no linked task has progress_cache = NULL, which the panel
# renders as "No plan yet" with a dashed empty track and an amber rot dot — on
# all seven nodes at once. THAT IS THE FRAME THAT SHIPPED. Tasks link to LEAF
# objectives only (heightBelow > 0 is rejected 422); parents roll up on their
# own. A link alone gives 0%, so some linked tasks are also closed — the rollup
# is estimate-weighted, and completed work is what makes the bars read.
say "objective links"
link()  { curl -fsS -XPOST  "$API/objectives/$1/tasks" -H "$JSON" -d "{\"task_id\":\"$(tsk "$2")\"}" >/dev/null; }
close() { curl -fsS -XPATCH "$API/tasks/$(tsk "$1")"   -H "$JSON" -d '{"status":"done"}'            >/dev/null; }

link "$O1" "Ship the auto-scheduler reactive reflow behind a flag"
link "$O1" "Write integration tests for the block engine"
link "$O1" "Triage the issue backlog and label everything"
close "Write integration tests for the block engine"

link "$O2" "Send Bluepeak the data schema and open a shared channel"
link "$O2" "Write the pilot success criteria down somewhere they can see it"
close "Send Bluepeak the data schema and open a shared channel"

# The outdoors goal has no backlog behind it — tasks.md is a work brain-dump —
# so its leaf gets two tasks of its own. Two extra rows, not a rewritten fixture.
# Created AFTER $TASKS was captured, so they are referenced by the id the POST
# returns rather than through tsk().
newt() { curl -fsS -XPOST "$API/tasks" -H "$JSON" -d "$1" | jq -r '.task.id // .id'; }
T1=$(newt '{"title":"Map the Skyline loop and book the campsite","estimated_minutes":45,"priority":2,"categories":["leisure","health"]}')
T2=$(newt '{"title":"Service the bike before the first long ride","estimated_minutes":60,"priority":3,"categories":["health"]}')
curl -fsS -XPOST  "$API/objectives/$O3/tasks" -H "$JSON" -d "{\"task_id\":\"$T1\"}" >/dev/null
curl -fsS -XPOST  "$API/objectives/$O3/tasks" -H "$JSON" -d "{\"task_id\":\"$T2\"}" >/dev/null
curl -fsS -XPATCH "$API/tasks/$T2" -H "$JSON" -d '{"status":"done"}' >/dev/null

# ── Tags ─────────────────────────────────────────────────────────────────────
# The seeder files every intention tag under nothing, so /tags — the
# tags-taxonomy shot, whose caption is "two axes of tags: direction, and
# intention" — renders HOME, WORK and COMMUNITY all reading "No tags yet." with a
# single UNSORTED card carrying all six. `directions` takes direction NAMES, not
# ids (services/tags.ts -> directionIds), and ids are uuid7, so resolve by name.
say "tags: directions and categories"
TAGS=$(curl -fsS "$API/tags")
tid() {
  local id
  id=$(echo "$TAGS" | jq -r --arg n "$1" '.tags[] | select(.name==$n and .kind=="intention") | .id')
  [ -n "$id" ] && [ "$id" != "null" ] || { echo "stage-data: no intention tag named \"$1\"" >&2; exit 1; }
  echo "$id"
}
file_tag() { curl -fsS -XPATCH "$API/tags/$(tid "$1")" -H "$JSON" -d "{\"directions\":[\"$2\"]}" >/dev/null; }
# The synthetic fixture yields six intention tags: product, clients, partnerships, admin,
# personal, submissions (bizdev / investment are gone since #563).
file_tag product work; file_tag clients work; file_tag partnerships work; file_tag admin work
file_tag personal home
file_tag submissions community

# …and each tag's Balance category. The per-chip category <select> defaults to an
# em dash, so without this every tag reads "#product —" and the frame is a column
# of placeholders.
file_cat() { curl -fsS -XPATCH "$API/tags/$(tid "$1")" -H "$JSON" -d "{\"categories\":[\"$2\"]}" >/dev/null; }
file_cat product career;      file_cat clients career
file_cat partnerships career; file_cat admin finance
file_cat personal relationships
file_cat submissions growth

# ── Rest-of-month commitments, LAST ──────────────────────────────────────────
# auto/fill above must not see them. The calendar fixture is one week wide
# (2026-05-30 .. 2026-06-06), so Month view renders June 8-30 as an empty grid —
# two thirds of the calendar-month frame. These are time BLOCKS rather than
# fixture events on purpose: the seeder mines every fixture event into a
# "Prep for …" task, so widening calendar.json would push the backlog past
# --target=40 and move every other shot. All fall outside the frozen day and
# outside the visible week, so nothing else moves.
say "rest-of-month commitments"
mtg() { # mtg <YYYY-MM-DD> <HH:MM> <minutes> <title>
  local s e
  s=$(python3 -c "import datetime;print(datetime.datetime.fromisoformat('$1T$2:00+00:00').isoformat().replace('+00:00','Z'))")
  e=$(python3 -c "import datetime;print((datetime.datetime.fromisoformat('$1T$2:00+00:00')+datetime.timedelta(minutes=$3)).isoformat().replace('+00:00','Z'))")
  curl -fsS -XPOST "$API/blocks" -H "$JSON" \
    -d "{\"title\":\"$4\",\"block_kind\":\"meeting\",\"is_locked\":true,\"start_at\":\"$s\",\"end_at\":\"$e\"}" >/dev/null
}
mtg 2026-06-09 09:00 30 "Cedar Systems onboarding standup"
mtg 2026-06-09 15:00 60 "Bluepeak data-schema review"
mtg 2026-06-10 11:00 45 "Platform team MCP connector scope"
mtg 2026-06-11 09:30 60 "Northwind Capital IC follow-on"
mtg 2026-06-12 14:00 45 "Orchard Labs co-marketing sync"
mtg 2026-06-15 09:00 30 "Cedar Systems onboarding standup"
mtg 2026-06-16 13:00 90 "SBIR narrative working session"
mtg 2026-06-17 10:00 60 "Lumen API contract review"
mtg 2026-06-18 16:00 45 "Vendor partner check-in"
mtg 2026-06-19 11:00 60 "Q2 board prep"
mtg 2026-06-22 09:00 30 "Cedar Systems onboarding standup"
mtg 2026-06-23 14:30 60 "Hardware partner BOM and pricing"
mtg 2026-06-24 10:00 45 "Accelerator mentor session"
mtg 2026-06-25 15:00 60 "LP annual meeting planning"
mtg 2026-06-26 12:30 60 "Lunch with mentor"
mtg 2026-06-29 09:00 30 "Cedar Systems onboarding standup"
mtg 2026-06-30 10:00 90 "Conference rehearsal"

# ── Assert the state the film needs ──────────────────────────────────────────
# The point of the whole file. "No plan yet" on all seven nodes is what shipped,
# and it shipped because nothing checked. A green exit here is a claim about the
# frames, so it is worth making it a real one.
#
# GET /objectives returns a TREE (routes/objectives.ts -> buildTree), not a flat
# list, so `.objectives | length` is the number of ROOTS — 2 — and asserting 7
# against it fails on a perfectly staged database. Recurse. (This assertion got
# that wrong first, refused a good stage, and is worth the comment: the count you
# want and the count the endpoint hands you are different numbers.)
# select on `horizon`, which only an objective has. Selecting on id+title also
# matched every LINKED TASK nested under a leaf and counted 21 for 7 — the same
# mistake in the other direction. Two wrong counts of one property is the house
# failure mode; this one is anchored on a field tasks do not carry.
nodes() { curl -fsS "$API/objectives" | jq '[.objectives | .. | objects | select(has("horizon") and has("title"))]'; }
total=$(nodes | jq 'length')
scored=$(nodes | jq '[.[] | select(.progress_cache != null)] | length')
[ "$total" = "7" ] || { echo "stage-data: expected 7 objectives, got $total" >&2; exit 1; }
[ "$scored" = "7" ] || {
  echo "stage-data: $scored/7 objectives have progress — the rest render \"No plan yet\"" >&2
  exit 1
}
untagged=$(curl -fsS "$API/tags" | jq '[.tags[] | select(.kind=="intention") | select((.directions // []) | length == 0)] | length')
[ "$untagged" = "0" ] || { echo "stage-data: $untagged intention tag(s) still unfiled" >&2; exit 1; }

echo "  stage-data: 7/7 objectives scored, 6 intention tags filed, 17 commitments"
