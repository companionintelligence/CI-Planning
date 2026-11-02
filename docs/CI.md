# Running CI for this repo

Automatic workflow triggers in this repository are **gated**: pushing does not
start a GitHub-hosted run any more. Checks run on local hardware, and the
workflows that remain are started deliberately.

Why: GitHub Actions was costing the org $563/month, almost all of it hosted
compute for checks that run just as well on hardware we already own.

Starting a gated workflow needs the [`gh` CLI](https://cli.github.com) and push
access. `--ref` matters - the workflow file is read from that branch, so a
workflow that only exists on your feature branch must be dispatched against it.

Full cross-repo runbook: `CI-Local-CICD/RUNBOOK.md` (regenerate with
`ci-local docs`). This file is generated - do not hand-edit. Two parts below were
corrected by hand because the generator does not know them (the mobile build, and the
tag ref on the release command); regenerating drops both. The merge gate itself is in
[CONTRIBUTING.md](../CONTRIBUTING.md).

---

Default branch: `main`

### Test locally

```bash
ci-local run --repo CI-Planning
```

Equivalent to:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
```

### Run a check workflow on GitHub

**CI** — `ci.yml`

```bash
gh workflow run ci.yml --repo companionintelligence/CI-Planning --ref main
```

**Style canon lint** — `style-canon-lint.yml`

```bash
gh workflow run style-canon-lint.yml --repo companionintelligence/CI-Planning --ref main
```

Locally: `pnpm lint:canon`.

### Build the mobile shells

**Mobile Build** — `mobile-build.yml`

Builds the Capacitor shells in `mobile/`: a debug Android APK and an unsigned iOS Simulator
`.app`, uploaded as workflow artifacts that expire after 7 days. It publishes nothing and
is independent of release tags.

```bash
gh workflow run mobile-build.yml --repo companionintelligence/CI-Planning --ref main
```

### Cut a release

**Publish container** — `docker-publish.yml`

Builds the image, smoke-tests it (standalone, local login and Companion Portal login),
then pushes it to GHCR. Dispatch it on the release tag's ref (for example `v4.2.2`): a tag
ref publishes `:latest`, `:sha-<short>` and `:<tag>`, with `CI_PLANNING_VERSION` set to the
tag without its `v`; any other ref publishes `:latest` and `:sha-<short>` as version
`0.0.0+sha-<short>`.

```bash
gh workflow run docker-publish.yml --repo companionintelligence/CI-Planning --ref <tag>
```
