# Application Style System

This is the app's single canonical style document. Components should use the color, typography, and shape rules here rather than add one-off visual tokens. The CSS custom properties in `client/src/index.css` implement the tokens, and `client/tailwind.config.js` exposes them to utility classes. The color system is "deep teal-navy", shared with CI-Hub. Light theme lives on `:root`, dark on `.dark`.

`index.css` first imports the CI-Common canon token layer (`@import "@companionintelligence/tokens/tokens.css"`, `index.css:7`) and then overrides surfaces and text on top of it. `--primary` is never one of the overrides: `pnpm lint:canon` (`ci-lint-canon`) and `client/src/theme-tokens.test.ts` fail if it drifts from the canon values below (phthalo `#0a6358` light, `#c5e8dc` dark).

## Shape and radius system

Only these five corner radii are permitted anywhere in the app:

| Token | Value | Use |
|---|---:|---|
| `--radius-0` | `0px` | Scheduled tasks and time blocks; square timeline and calendar items |
| `--radius-3` | `3px` | Compact cards, controls, pills, and subtle corners |
| `--radius-8` | `8px` | Outer surfaces and dialogs |
| `--radius-30` | `30px` | Large sheet corners and deliberately soft display surfaces |
| `--radius-999` | `999px` | True circles such as dots, avatars, and swatches |

Use the `rounded-*` utility classes; they all resolve through `client/tailwind.config.js` to this scale. Utility names collapse onto the same canonical values: default/`xs`/`sm`/`md`/`lg`/`full` map to 3px, `xl`/`2xl` map to 8px, and `3xl`/`4xl`/`5xl` map to 30px. `none` maps to 0px and the app-specific `circle` utility maps to 999px. Use 3px for pills and compact cards. Do not add arbitrary radius classes or raw radius values. For direct or inline CSS, use the `--radius-*` variables; avoid `inherit` and `calc()` so every radius can be audited against the scale.

Task and time-block representations must be square, including list cards and scheduled calendar/planner shapes. Their detail dialogs and unrelated controls may use the standard surface radius.

## Where styles and color tokens are defined

- `client/src/index.css` defines semantic color variables, the canonical radius scale, and shared component styles.
- `client/tailwind.config.js` maps those tokens to Tailwind utilities (`bg-card`, `text-primary`, `bg-tag-1`, and `rounded-*`) and defines the constant brand scales (`ci-*`, `accent-*`).
- `client/src/lib/pattern-meta.ts` and `client/src/lib/textures.ts` pick tokens at runtime (patterns, tags), always referencing tokens, never hex.
- `server/src/routes/auth.ts` and `server/src/scripts/fixture-portal.ts` contain self-contained HTML pages. Their radius declarations use the same tokens and values because they render without the SPA stylesheet; the fixture keeps its separate palette to mimic an external provider. Inline component styles must use a canonical CSS variable, such as `var(--radius-0)` for square task and block overlays.

## Semantic tokens (flip with theme)

These are the primary tokens. Use them via Tailwind (`bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`, etc.).

| Token | Light (`:root`) | Dark (`.dark`) |
|---|---|---|
| `--background` | `#f3f3f3` | `#041620` |
| `--foreground` | `#010f16` | `#88a29e` |
| `--card` | `#f7f7f9` | `#0a222e` |
| `--details-panel-background` | `color-mix(in srgb, var(--background) 93.6%, #000 6.4%)` | `var(--card)` |
| `--card-foreground` | `#041620` | `#88a29e` |
| `--popover` | `oklch(100% 0 0)` | `#0a222e` |
| `--popover-foreground` | `#041620` | `#88a29e` |
| `--primary` | `#0a6358` | `#c5e8dc` |
| `--primary-foreground` | `oklch(98.4% 0.003 247.858)` | `#041620` |
| `--secondary` | `oklch(96.8% 0.007 247.896)` | `#0a222e` |
| `--secondary-foreground` | `#0a222e` | `#f5f8fa` |
| `--muted` | `oklch(96.8% 0.007 247.896)` | `#0a222e` |
| `--muted-foreground` | `oklch(55.4% 0.046 257.417)` | `#8f98a3` |
| `--accent` | `oklch(96.8% 0.007 247.896)` | `#2c676d` |
| `--accent-foreground` | `#0a222e` | `#f5f8fa` |
| `--destructive` | `oklch(62% 0.22 27)` | `#ef7070` |
| `--destructive-foreground` | `oklch(98.4% 0.003 247.858)` | `#f5f8fa` |
| `--border` | `oklch(92.9% 0.013 255.508)` | `#2c676d` |
| `--input` | `oklch(92.9% 0.013 255.508)` | `#6992a2` |
| `--ring` | `oklch(70.4% 0.04 256.788)` | `#58ebbf` |

## Typography

Manrope is the application font for sans-serif and headings. Source Code Pro is the monospace fallback for times and other tabular/technical values. Use the existing semantic text-size and weight utilities instead of per-component font imports.

### Chart colors

| Token | Light | Dark |
|---|---|---|
| `--chart-1` | `oklch(64.6% 0.222 41.116)` | `#58ebbf` |
| `--chart-2` | `oklch(60% 0.118 184.704)` | `#409b9b` |
| `--chart-3` | `oklch(39.8% 0.07 227.392)` | `#079d99` |
| `--chart-4` | `oklch(82.8% 0.189 84.429)` | `#70a6af` |
| `--chart-5` | `oklch(76.9% 0.188 70.08)` | `#2c676d` |

### Sidebar colors

In light mode, the left sidebar is 20% closer to the center surface than its previous 15% shade. The details drawer is 20% closer than its previous 8% shade. Dark-mode panel colors are unchanged.

| Token | Light | Dark |
|---|---|---|
| `--sidebar` | `color-mix(in srgb, var(--background) 88%, #000 12%)` | `#041620` |
| `--sidebar-foreground` | `oklch(12.9% 0.042 264.695)` | `#f5f8fa` |
| `--sidebar-accent` | `oklch(96.8% 0.007 247.896)` | `#1d293d` |
| `--sidebar-accent-foreground` | `#0a222e` | `#f5f8fa` |
| `--sidebar-border` | `oklch(92.9% 0.013 255.508)` | `#2c676d` |
| `--sidebar-ring` | `#70a6af` | `#58ebbf` |

### Enriched tokens

Also in `index.css`, beyond the shadcn-style set above:

| Token | Light (`:root`) | Dark (`.dark`) |
|---|---|---|
| `--success` / `--success-foreground` | `#16a34a` / `#ffffff` | `#4ade80` / `#052e16` |
| `--warning` / `--warning-foreground` | `#d97706` / `#ffffff` | `#fbbf24` / `#422006` |
| `--info` / `--info-foreground` | `#0284c7` / `#ffffff` | `#38bdf8` / `#082f49` |

Mode-independent: the teal ramp `--teal-50` … `--teal-950` (`#eef7f8` … `#041620`), `--aqua` `#00a9a7`, `--aqua-light` `#72ddd4`, `--mint` `#58ebbf`, `--teal-accent` `#2c676d`, `--teal-mid` `#409b9b`, and the radius scale `--radius-sm` … `--radius-2xl`. `--gradient-brand`, `--gradient-hero`, `--gradient-aurora` and `--shadow-sm|md|lg` exist too (`--gradient-aurora` and the shadows differ per mode). `--select-chevron` is the themed `<select>` arrow.

## Brand teal scale (constant across modes)

Defined in `tailwind.config.js`, not theme-dependent. This is the signature CI interaction family: CTAs, focus, glow. Used as `bg-ci-3`, `text-ci-2`, etc.

| Key | Hex |
|---|---|
| `ci-1` | `#ABD4D8` |
| `ci-2` | `#85c3b4` |
| `ci-3` | `#58ebbf` |
| `ci-4` | `#409b9b` |
| `ci-5` | `#2c676d` |
| `ci-6` | `#1d5f6e` |
| `ci-7` | `#0f717a` |
| `ci-8` | `#079d99` |
| `ci-9` | `#82ffe1` |
| `ci-10` | `#244859` |
| `ci-11` | `#172e39` |

The `accent-*` utility keeps the bright legacy teal: `accent` `#409b9b`, `accent-hi` `#58ebbf`, `accent-light` `#ABD4D8`, `accent-glow` `#82ffe1`. Note that `bg-accent` is this constant `#409b9b`, not the themed `--accent` variable in the table above.

## Tag palette (categorical labels only)

12 complementary hues defined in `index.css` with theme-aware bases. Light mode uses brighter, more colorful shades while dark mode keeps the established vivid palette. Use these only for categorical labels (tags, chips, status pills), never for primary CTAs. Keep one tag color per semantic category. Bases are exposed as `bg-tag-1` through `bg-tag-12`; variants are reached via `var(--tag-N-...)`.

Each hue gives 6 saturation steps at L62% (`s6` vivid down to `s1` near-neutral) and 3 dark steps at S54% (`d3` down to `d1` deepest). `--tag-N` is the balanced base.

| Token | Name | Light | Dark | Hue |
|---|---|---|---|---|
| `--tag-1` | Carnelian | `#e86d47` | `#e07a5f` | 14 |
| `--tag-2` | Sunstone | `#d17c1a` | `#f2a65a` | 32 |
| `--tag-3` | Pyrite | `#aa8c15` | `#f4d35e` | 48 |
| `--tag-4` | Citrine | `#7a9a13` | `#c3d86d` | 74 |
| `--tag-5` | Jade | `#14a549` | `#8ecf9e` | 142 |
| `--tag-6` | Amazonite | `#14a092` | `#6ec9c2` | 174 |
| `--tag-7` | Aquamarine | `#5b90eb` | `#78a6f5` | 218 |
| `--tag-8` | Amethyst | `#8982f0` | `#8b8fe5` | 244 |
| `--tag-9` | Kunzite | `#ad75ee` | `#b18bd9` | 268 |
| `--tag-10` | Rhodochrosite | `#eb59bf` | `#d28fc1` | 318 |
| `--tag-11` | Rhodonite | `#ec618f` | `#e89ab0` | 340 |
| `--tag-12` | Topaz | `#e47226` | `#d7a37a` | 24 |

Variant pattern per hue (example for tag-1, hue 14):

- saturation steps: `s6` `hsl(14 78% 62%)`, `s5` `hsl(14 66% 62%)`, `s4` `hsl(14 54% 62%)`, `s3` `hsl(14 42% 62%)`, `s2` `hsl(14 30% 62%)`, `s1` `hsl(14 18% 62%)`
- dark steps: `d3` `hsl(14 54% 48%)`, `d2` `hsl(14 54% 38%)`, `d1` `hsl(14 54% 28%)`

Every other hue follows the same formula with its own hue number.

A tag string maps deterministically to a hue via an FNV hash, `tag-${(seed % 12) + 1}` (see `tagHueToken` in `lib/textures.ts`), so a given tag always renders the same color.

## Pattern colors (runtime token picks)

From `lib/pattern-meta.ts`. Patterns store CI-Hub token keys (e.g. `chart-1`), never hex, so they stay on the design system and flip with theme.

Core (teal-first, the main interaction family): `primary` (Primary), `chart-1` (Mint), `chart-3` (Aqua), `chart-4` (Steel), `chart-5` (Navy). The labels name the dark-mode values; the `chart-*` tokens are different hues in light mode (see the chart table above).

Tag hues: the 12 `tag-1` through `tag-12` listed above.

Base tag defaults: `community` uses `primary`, `home` uses `chart-1`, `work` uses `chart-4`.

## Hard-coded colors in component styles

A few values are intentionally fixed (constant across modes) in `index.css`:

- Primary actions (`.btn-primary`, `.fab`, `.checkbox-checked`) are not hard-coded any more: they fill with `var(--primary)` and put `var(--primary-foreground)` on it, so they flip with the theme. The old mint gradient (`linear-gradient(135deg, #58ebbf, #409b9b)`) is gone from `index.css`. Hover is `color-mix(in srgb, var(--primary) 90%, transparent)` plus a primary-tinted shadow.
- Active nav item (`.nav-item-active`): text `var(--primary)` on `var(--sidebar-accent)`, with a `2px solid var(--primary)` left border.
- Priority dots: `p1` `#ef4444`, `p2` `#f97316`, `p3` `#58ebbf`, `p4` `#409b9b`, `p5` `#244859` (each with a matching glow shadow).
- Glow shadows in the places that keep them (focused inputs, `.card-hover`, the P3 dot, `toast-success`, the done-pulse) use `rgba(88,235,191,...)` (the mint `#58ebbf`), e.g. `shadow-glow-ci` `0 0 20px -4px rgba(88,235,191,.35)`.
- Modal backdrop: `rgba(0,0,0,.7)` with a 6px blur.
- Badge tints (dark): green on `rgba(88,235,191,.12)`, yellow on `bg-yellow-900/40` text `yellow-400`, red on `bg-red-900/40` text `red-400`. In light mode (`:root:not(.dark)`) the teal-family badges switch to `--teal-900` text, yellow becomes `#fef3c7` on `#92400e`, and red `#fee2e2` on `#b91c1c`.

## Legacy scale remaps

To keep older utilities themeable, `tailwind.config.js` remaps:

- `surface-950/900/800/700/600/500` onto `--background` / `--sidebar` / `--card` / `--border` / `--input`.
- `slate-*` text shades onto themed text tokens (50 to 200 prominent headings, 300 to 400 body, 500 to 700 muted, 800 to 950 backgrounds).
