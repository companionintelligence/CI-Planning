# Factory — idea → tickets workflow

Factory is how a rough feature idea becomes a set of small, testable tickets on a
GitHub **project board**, worked by AI models with an auditable comment trail.

- **`/factory` slash command** (`.claude/commands/factory.md`) — the tool. Runs an
  interactive interview, breaks the idea into tickets, and creates them as GitHub
  issues on the Factory board.
- **Issue template** (`.github/ISSUE_TEMPLATE/factory-ticket.md`) — the ticket
  structure, also usable when creating an issue by hand in the GitHub UI.
- **Helper CLI** (`scripts/factory/factory.sh`) — thin `gh` wrapper that creates
  issues, adds them to the board, and posts the working-model comments.

## Ticket structure

A Factory ticket reads like a **git commit recipe**: exact files, exact schema, exact
constraints, exact verification commands. Anything left to interpretation is a bug in
the ticket. The full structure (see `.github/ISSUE_TEMPLATE/factory-ticket.md`):

- **Metadata** — Type, Phase, Branch (`type/short-scope`), Commit style
  (`type(scope): summary`), Design link, Dependencies.
- **Goal** — the outcome and why.
- **Non-goals** — explicit fences so the working model doesn't build adjacent things
  (CRUD, UI, jobs, business logic). *Mandatory.*
- **Pinned conventions** — the exact, verified conventions the change must match
  (naming, types, FK on-delete, enum/constraint approach, id generation, timestamps).
  State the values; never write "match convention" without saying what it is.
- **Before implementation** — the exact files/patterns to read first.
- **Files impacted** — real paths, split New vs Changed.
- **Schema required** — exact columns, defaults, nullability, FK on-delete, unique
  tuples, indexes; or `None`.
- **Definition of Done** — the checklist that must be true to close.
- **Tests** — checkbox cases plus the verification commands that must pass.
- **Acceptance Criteria** — observable, verifiable checks.
- **Subtasks** — atomic, ordered steps.

A good ticket is independently mergeable and independently testable. Prefer several
small tickets over one big one. When a section genuinely doesn't apply, write `None` /
`N/A` — don't drop the heading.

The `/factory` command pins conventions by **inspecting the real code** before drafting,
so tickets encode actual repo patterns (e.g. this repo enforces status enums in code,
not with `CHECK` constraints) rather than guesses.

## Working-model comment protocol

When a model picks up a ticket to implement it, it brackets the work with two comments:

- **On start** — model name + UTC start time:

  ```bash
  scripts/factory/factory.sh start <issue> "<model-name>"
  ```

- **On completion** — total token count for the ticket:

  ```bash
  scripts/factory/factory.sh finish <issue> --total <tokens> [--in <n> --out <n>]
  ```

The token count is supplied by the working model from its own usage accounting — a
shell script has no way to know it, so the model must pass it in.

## One-time setup

1. **Install and authenticate the GitHub CLI:**

   ```bash
   gh auth status   # or: gh auth login
   ```

   The account needs `repo` and `project` scopes:

   ```bash
   gh auth refresh -s project,read:project
   ```

2. **Create the Factory project board** (Projects v2), once, under the repo owner:

   ```bash
   gh project create --owner companionintelligence --title "Factory"
   ```

   Then link it to the repo so issues show up on it:

   ```bash
   gh project link <number> --owner companionintelligence --repo companionintelligence/CI-Planning
   ```

3. **Make sure the helper is executable.** It is committed with the executable bit; if
   your checkout lost it (a zip download, some Windows setups):

   ```bash
   chmod +x scripts/factory/factory.sh
   ```

## Usage

In Claude Code, from the repo root:

```
/factory add a bulk-tagging action to the Tags view
```

The command interviews you, proposes a ticket breakdown for your approval, drafts each
ticket body under `docs/factory/drafts/`, and — after you approve — creates the issues
on the Factory board. It never creates issues before you approve.

## Configuration

`scripts/factory/factory.sh` derives repo and owner from `gh` automatically. Override
with environment variables when needed:

| Variable          | Default                | Purpose                     |
| ----------------- | ---------------------- | --------------------------- |
| `FACTORY_REPO`    | current repo via `gh`  | `owner/repo` for issues     |
| `FACTORY_OWNER`   | repo owner via `gh`    | project owner login         |
| `FACTORY_PROJECT` | `Factory`              | project board title         |
| `FACTORY_LABEL`   | `factory`              | default label on tickets    |

## Manual commands (reference)

```bash
# Create a ticket from a body file
scripts/factory/factory.sh create --title "[Factory] Bulk tag action" \
  --body-file docs/factory/drafts/bulk-tag.md

# Stamp start / completion
scripts/factory/factory.sh start 42 "claude-opus-4-8"
scripts/factory/factory.sh finish 42 --total 128000 --in 96000 --out 32000
```
