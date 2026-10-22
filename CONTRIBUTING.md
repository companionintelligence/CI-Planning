# Contributing

## Merge policy — green CI is required before merge

**Do not merge a pull request into `main` while any required check is red.**

Every PR runs the CI workflows in `.github/workflows`. Two checks gate `main`:

- **Typecheck + Unit + Integration**
- **Build, screenshot-test, publish**

Both must be **green** on the PR's latest commit before you merge. This is
enforced by branch protection on `main` (required status checks), but treat it as
a standing rule regardless of tooling — a red check means `main` will not compile
or will ship a broken build to everyone.

### Watch out for autofix / suggestion commits

If a bot pushes a new commit to the branch after checks passed — for example a
GitHub **Copilot "Potential fix for pull request finding"** autofix, or an applied
review suggestion — that new commit **re-runs the required checks**. Wait for them
to go green again before merging. A dropped paren from exactly this kind of autofix
put a non-compiling `main` into the tree once (PRs #321 → #322); the required-check
gate exists to prevent a repeat.

### If CI is genuinely broken (not your change)

Admins can bypass the gate in a real emergency (e.g. a flaky/broken CI runner), but
prefer fixing or re-running the check. If you bypass, say so in the PR and open a
follow-up to restore green CI.

## Fresh clone install

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
