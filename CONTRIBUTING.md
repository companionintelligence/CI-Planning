# Contributing

## Merge policy — green checks are required before merge

**Do not merge a pull request into `main` while the typecheck, build or tests are red.**

GitHub Actions are manual in this repo: every workflow in `.github/workflows` is
`workflow_dispatch`-only (owner decision, #618, kept in the 2026-10-21 readiness pass:
"test local, no GitHub Actions"), so a push or a pull request starts no run. The gate runs
on your machine, from the repo root, before you merge:

```bash
pnpm typecheck && pnpm build && pnpm test
pnpm lint:canon        # the design-canon lint that style-canon-lint.yml runs
```

(`server/vitest.config.ts` sets `GOOGLE_MODE=fixture` and `LOG_LEVEL=error` for the server
tests, so no extra environment is needed.) A change that touches the container, the login
paths or the security headers should also pass `tests/container/run-local.sh`, which boots
the three app shapes `docker-publish.yml` smoke-tests and runs the Playwright specs against
each, without Docker; its header lists the one-time setup.

All of it must be **green** on the PR's latest commit before you merge. A red result
means `main` will not compile or will ship a broken build to everyone. Whether branch
protection enforces this is set by the repository owner, so do not assume it does. For a
second opinion from a clean runner, dispatch `ci.yml` by hand (its **Typecheck + Unit +
Integration** job). Dispatching `docker-publish.yml` also publishes the image, so it is not a
dry run. The commands are in [docs/CI.md](docs/CI.md).

### Watch out for autofix / suggestion commits

If a bot pushes a new commit to the branch after you ran the gate — for example a
GitHub **Copilot "Potential fix for pull request finding"** autofix, or an applied
review suggestion — your result no longer covers the branch. Run the gate again on the
new tip and wait for it to go green before merging. A dropped paren from exactly this
kind of autofix put a non-compiling `main` into the tree once (PRs #321 → #322); the
rule exists to prevent a repeat.

### If the gate is broken (not your change)

Prefer fixing or re-running the check. If you merge past a red result that is genuinely
not yours (say, a flaky test), say so in the PR and open a follow-up to restore green.

## Fresh clone install

Node 22 or newer is required (`engines` in `package.json`; `.nvmrc` pins 26.3.0, the
major the Dockerfile builds on).

The workspace depends on private `@companionintelligence/*` packages from GitHub
Packages. The repo `.npmrc` points that scope at `npm.pkg.github.com` with a
`${NODE_AUTH_TOKEN}` placeholder — and **pnpm 11 does not expand environment variables
in a repository-controlled `.npmrc`**, so exporting `NODE_AUTH_TOKEN` is not enough: a
fresh clone fails the lockfile's supply-chain check on those packages. Put the token in a
**user-level** npmrc instead, once per machine:

```bash
printf '//npm.pkg.github.com/:_authToken=%s\n' "$(gh auth token)" > ~/.npmrc
```

(`gh auth login` first if you have not; the token needs the `read:packages` scope.) If you
would rather not touch `~/.npmrc`, point pnpm at any file with the same line:

```bash
npm_config_userconfig=/path/to/npmrc-with-token pnpm install --frozen-lockfile
```

Then `corepack enable && pnpm install --frozen-lockfile` from the repo root.

**Read the install output, not just its exit code.** `pnpm install` can print a
supply-chain / registry failure for the private packages and still exit 0 when its output
goes through a pipe (`pnpm install | tee …`, `2>&1 | tail`), so a wrapper script that only
checks `$?` reports a broken install as a success. Run it unpiped, or grep the log for
`ERR_PNPM` / `supply chain` before trusting it. The symptom of a half-installed tree is a
later `tsx`/`vite` run failing on a missing `@companionintelligence/…` module.
