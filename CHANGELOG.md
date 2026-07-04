# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — Design system

- **Adopted the Companion Intelligence canonical theme.** The client now resolves
  its `--primary` to the CI teal — `#0f717a` in light mode (`:root`) and `#abd4d8`
  in dark mode (`.dark`) — and sets **Montserrat** as the base UI type. Surfaces and
  text resolve through the shared CI-Hub token contract (`--background`,
  `--foreground`, `--card`, `--border`, `--sidebar-*`, …), aligned with the
  Companion Intelligence design system (CI-Common `style/` · CI-Hub `globals.css`).
- **Enriched design tokens v0.2.0** in `client/src/index.css`:
  - Brand **teal ramp** `--teal-50 … --teal-950`.
  - **Aqua / mint accents** (`--aqua`, `--aqua-light`, `--mint`, `--teal-accent`,
    `--teal-mid`).
  - **Semantic status** tokens with light/dark values — `--success`, `--warning`,
    `--info` (plus their `-foreground` pairs; `--destructive` already themed).
  - **Gradients** — `--gradient-brand`, `--gradient-hero`, `--gradient-aurora`.
  - **Radius scale** — `--radius-sm … --radius-2xl`, derived from `--radius`.
  - **Elevation** — `--shadow-sm/-md/-lg`, mode-aware.
  - A 12-hue **tag palette** (`--tag-1 … --tag-12`, each with saturation and dark
    steps) for categorical labels only, kept distinct from the teal interaction color.

### Added — Design-canon lint gate

- `scripts/lint-canon.mjs` — zero-dependency Node script that fails if any
  resolvable `--primary` custom property is not the CI teal (parses hex, rgb, hsl,
  bare hsl-triplet, oklch, and oklab; warns non-fatally on hardcoded hex in
  component source).
- `.github/workflows/style-canon-lint.yml` — runs the canon lint on every push and
  pull request.
- `client/src/theme-tokens.test.ts` — fast unit canary asserting the light/dark
  `--primary` canon contract in the client test suite.

### Added — Documentation

- Refreshed light **and** dark UI screenshots for the major screens
  (`docs/ui/planning-{today,calendar,inbox,tasks,objectives}-{light,dark}.png`) and
  a design-system note in the README pointing at the CI canonical style source.
