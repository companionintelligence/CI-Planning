# Production readiness review — 2026-11-11

## Scope

Static review of CI-Planning `main` at `e364e1c3`, the release and container workflows,
and the current CI-Marketplace app manifest. The working branch also includes the pending
Settings → People tab change. This review did not run tests, install a Hub image, or verify
a live production login.

## Release assessment

**Do not treat the current source snapshot as a production release until the release gates
below are completed.** The app has a mature local-first core and several older findings are
already fixed, but the latest tagged image does not include all current source changes and
the repository does not run its CI or publish workflows automatically.

| Priority | Finding | Evidence | Before shipping |
| --- | --- | --- | --- |
| High | CI and image publishing are manual-only. | `.github/workflows/ci.yml`, `docker-publish.yml`, and `style-canon-lint.yml` each use `workflow_dispatch` only. The latest successful CI run in GitHub Actions was Nov 2, before the current `main` commit. | Run CI and the container build/smoke workflow against the exact release candidate. Decide whether to restore PR checks or retain a documented owner-run gate. |
| High | The published release trails current source. | Latest release is `v4.2.2` (Oct 30); `main` is 49 commits beyond that tag. The latest successful container publish run is Oct 30. Root `package.json` still reports `4.2.0`. | Choose the next release version, align package and image version reporting, publish from the release tag, and verify the image digest/version in the Hub listing. |
| High | Marketplace privacy copy is inaccurate. | `CI-Marketplace/apps/ci-planning/config.json` says “No telemetry,” while the same install form enables **Share crash reports** by default. Released images can send scrubbed error reports unless disabled. | Replace “No telemetry” in the listing and its metadata with the actual disclosure, including the default and opt-out control. |
| Medium | User documentation described an obsolete first-run flow. | The current app has a ten-step onboarding flow; CI-Docs described five steps and labeled the app version `0.3`. | Update the Companion Planning page and recapture the outdated onboarding screenshot before publishing it. |
| Medium | Production operation still needs an end-to-end check. | This review was source/config only; it did not validate a clean Hub install, local sign-up, data persistence/restore, or the crash-report opt-out on the release image. | Run the install and account flows on the release image; verify restart and backup restore; confirm optional integrations and telemetry behavior match the operator's choices. |

## Findings already resolved in current source

- The shared OIDC verifier accepts RS256 and EdDSA/Ed25519 with matching JWK shapes; the
  old “RS256-only” production Portal finding in the Oct 21 review is stale.
- Security headers are installed in `server/src/app.ts`; the old “no security headers” item
  is stale.
- Docker Compose keeps the in-progress Postgres service behind the `postgres` profile;
  SQLite remains the default store.

## Documentation changes in progress

The README now identifies the latest release separately from unreleased `main`, lists the
current migration head, explains optional integrations and crash reporting, and links this
review. The CI-Docs Companion Planning page is being updated on its own branch to describe
the current features and ten-step onboarding flow. The Marketplace listing still needs its
separate copy correction.
