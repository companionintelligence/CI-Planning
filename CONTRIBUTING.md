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
