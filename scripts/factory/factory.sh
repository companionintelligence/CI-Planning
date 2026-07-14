#!/usr/bin/env bash
#
# factory.sh — thin wrapper around `gh` for the Factory ticket workflow.
#
# Subcommands:
#   create   Create a GitHub issue from a body file and add it to the Factory
#            project board. Prints "<number>\t<url>" on success.
#   start    Post the "started" comment (model name + UTC start time) on a ticket.
#   finish   Post the "completed" comment (token usage) on a ticket.
#
# Config (env vars, all optional — sensible defaults are derived from `gh`):
#   FACTORY_REPO     owner/repo         (default: current repo via gh)
#   FACTORY_OWNER    project owner login (default: repo owner via gh)
#   FACTORY_PROJECT  project title       (default: "Factory")
#   FACTORY_LABEL    default label       (default: "factory")
#
# Requires: gh (authenticated), jq is NOT required (uses gh --jq).
set -euo pipefail

FACTORY_PROJECT="${FACTORY_PROJECT:-Factory}"
FACTORY_LABEL="${FACTORY_LABEL:-factory}"

die() { echo "factory: $*" >&2; exit 1; }

require_gh() {
  command -v gh >/dev/null 2>&1 || die "gh CLI not found. Install: https://cli.github.com/"
}

repo() {
  if [[ -n "${FACTORY_REPO:-}" ]]; then echo "$FACTORY_REPO"; return; fi
  gh repo view --json nameWithOwner --jq .nameWithOwner
}

owner() {
  if [[ -n "${FACTORY_OWNER:-}" ]]; then echo "$FACTORY_OWNER"; return; fi
  gh repo view --json owner --jq .owner.login
}

# Resolve the Projects-v2 number for FACTORY_PROJECT under the owner.
# Prints the number, or empty string if not found.
project_number() {
  local o; o="$(owner)"
  gh project list --owner "$o" --format json \
    --jq ".projects[] | select(.title==\"$FACTORY_PROJECT\") | .number" 2>/dev/null | head -n1
}

cmd_create() {
  local title="" body_file="" labels="$FACTORY_LABEL"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title)      title="$2"; shift 2 ;;
      --body-file)  body_file="$2"; shift 2 ;;
      --labels)     labels="$2"; shift 2 ;;
      *) die "create: unknown arg '$1'" ;;
    esac
  done
  [[ -n "$title" ]]      || die "create: --title is required"
  [[ -n "$body_file" ]]  || die "create: --body-file is required"
  [[ -f "$body_file" ]]  || die "create: body file not found: $body_file"

  local r; r="$(repo)"

  # Create the issue. Labels are best-effort: if a label doesn't exist gh errors,
  # so create it on demand first.
  IFS=',' read -ra _labels <<< "$labels"
  for l in "${_labels[@]}"; do
    l="$(echo "$l" | xargs)"; [[ -z "$l" ]] && continue
    gh label create "$l" --repo "$r" --color BFD4F2 --force >/dev/null 2>&1 || true
  done

  local url
  url="$(gh issue create --repo "$r" --title "$title" --body-file "$body_file" --label "$labels")"
  local number="${url##*/}"

  # Add to the Factory project board (best-effort — never fail issue creation).
  local pn; pn="$(project_number || true)"
  if [[ -n "$pn" ]]; then
    gh project item-add "$pn" --owner "$(owner)" --url "$url" >/dev/null 2>&1 \
      && echo "factory: added #$number to project '$FACTORY_PROJECT'" >&2 \
      || echo "factory: WARN could not add #$number to project '$FACTORY_PROJECT'" >&2
  else
    echo "factory: WARN project '$FACTORY_PROJECT' not found for owner '$(owner)' — issue created but not added to a board." >&2
  fi

  printf '%s\t%s\n' "$number" "$url"
}

cmd_start() {
  local number="${1:-}" model="${2:-}"
  [[ -n "$number" ]] || die "start: usage: factory.sh start <issue> <model-name>"
  [[ -n "$model" ]]  || die "start: usage: factory.sh start <issue> <model-name>"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local body
  body="$(printf '🤖 **Ticket started**\n\n- **Model:** \`%s\`\n- **Started:** %s' "$model" "$now")"
  gh issue comment "$number" --repo "$(repo)" --body "$body"
}

cmd_finish() {
  local number="${1:-}"; shift || true
  [[ -n "$number" ]] || die "finish: usage: factory.sh finish <issue> --total N [--in N --out N]"
  local total="" tin="" tout=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --total) total="$2"; shift 2 ;;
      --in)    tin="$2"; shift 2 ;;
      --out)   tout="$2"; shift 2 ;;
      *) die "finish: unknown arg '$1'" ;;
    esac
  done
  [[ -n "$total" ]] || die "finish: --total is required"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local breakdown=""
  [[ -n "$tin" || -n "$tout" ]] && breakdown="$(printf '\n- **Breakdown:** in %s / out %s' "${tin:-?}" "${tout:-?}")"
  local body
  body="$(printf '✅ **Ticket completed**\n\n- **Total tokens:** %s%s\n- **Finished:** %s' "$total" "$breakdown" "$now")"
  gh issue comment "$number" --repo "$(repo)" --body "$body"
}

sub="${1:-help}"; shift || true
case "$sub" in
  create) require_gh; cmd_create "$@" ;;
  start)  require_gh; cmd_start "$@" ;;
  finish) require_gh; cmd_finish "$@" ;;
  help|-h|--help)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown subcommand '$sub' (try: create | start | finish | help)" ;;
esac
