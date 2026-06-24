# Color Styling Rules

All color in the app resolves to a single source of truth: the CSS custom properties in `client/src/index.css`, surfaced to utility classes through `client/tailwind.config.js`. The system is "deep teal-navy", shared with CI-Hub. Light theme lives on `:root`, dark on `.dark`.

## Where colors are defined

- `client/src/index.css` defines all raw color values as CSS variables (semantic tokens, tag palette) plus the component styles that consume them.
- `client/tailwind.config.js` maps those variables to Tailwind utilities (`bg-card`, `text-primary`, `bg-tag-1`, etc.) and defines the constant brand scales (`ci-*`, `accent-*`).
- `client/src/lib/pattern-meta.ts` and `client/src/lib/textures.ts` pick tokens at runtime (patterns, tags), always referencing tokens, never hex.

## Semantic tokens (flip with theme)

These are the primary tokens. Use them via Tailwind (`bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`, etc.).

| Token | Light (`:root`) | Dark (`.dark`) |
|---|---|---|
| `--background` | `#f3f3f3` | `#041620` |
| `--foreground` | `#010f16` | `#88a29e` |
| `--card` | `#f7f7f9` | `#0a222e` |
| `--card-foreground` | `#041620` | `#88a29e` |
| `--popover` | `oklch(100% 0 0)` | `#0a222e` |
| `--popover-foreground` | `#041620` | `#88a29e` |
| `--primary` | `#0f717a` | `#abd4d8` |
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
| `--radius` | `0.625rem` | (same) |

### Chart colors

| Token | Light | Dark |
|---|---|---|
| `--chart-1` | `oklch(64.6% 0.222 41.116)` | `#58ebbf` |
| `--chart-2` | `oklch(60% 0.118 184.704)` | `#409b9b` |
| `--chart-3` | `oklch(39.8% 0.07 227.392)` | `#079d99` |
| `--chart-4` | `oklch(82.8% 0.189 84.429)` | `#70a6af` |
| `--chart-5` | `oklch(76.9% 0.188 70.08)` | `#2c676d` |

### Sidebar colors

| Token | Light | Dark |
|---|---|---|
| `--sidebar` | `oklch(98.4% 0.003 247.858)` | `#041620` |
| `--sidebar-foreground` | `oklch(12.9% 0.042 264.695)` | `#f5f8fa` |
| `--sidebar-accent` | `oklch(96.8% 0.007 247.896)` | `#1d293d` |
| `--sidebar-accent-foreground` | `#0a222e` | `#f5f8fa` |
| `--sidebar-border` | `oklch(92.9% 0.013 255.508)` | `#2c676d` |
| `--sidebar-ring` | `#70a6af` | `#58ebbf` |

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

The `accent-*` utility keeps the bright legacy teal: `accent` `#409b9b`, `accent-hi` `#58ebbf`, `accent-light` `#ABD4D8`, `accent-glow` `#82ffe1`.

## Tag palette (categorical labels only)

12 complementary hues defined once in `index.css`, shared by light and dark. Rule: use only for categorical labels (tags, chips, status pills), never for primary CTAs. Keep one tag color per semantic category. Bases are exposed as `bg-tag-1` through `bg-tag-12`; variants are reached via `var(--tag-N-...)`.

Each hue gives 6 saturation steps at L62% (`s6` vivid down to `s1` near-neutral) and 3 dark steps at S54% (`d3` down to `d1` deepest). `--tag-N` is the balanced base.

| Token | Name | Base | Hue |
|---|---|---|---|
| `--tag-1` | Carnelian | `#e07a5f` | 14 |
| `--tag-2` | Sunstone | `#f2a65a` | 32 |
| `--tag-3` | Pyrite | `#f4d35e` | 48 |
| `--tag-4` | Citrine | `#c3d86d` | 74 |
| `--tag-5` | Jade | `#8ecf9e` | 142 |
| `--tag-6` | Amazonite | `#6ec9c2` | 174 |
| `--tag-7` | Aquamarine | `#78a6f5` | 218 |
| `--tag-8` | Amethyst | `#8b8fe5` | 244 |
| `--tag-9` | Kunzite | `#b18bd9` | 268 |
| `--tag-10` | Rhodochrosite | `#d28fc1` | 318 |
| `--tag-11` | Rhodonite | `#e89ab0` | 340 |
| `--tag-12` | Topaz | `#d7a37a` | 24 |

Variant pattern per hue (example for tag-1, hue 14):

- saturation steps: `s6` `hsl(14 78% 62%)`, `s5` `hsl(14 66% 62%)`, `s4` `hsl(14 54% 62%)`, `s3` `hsl(14 42% 62%)`, `s2` `hsl(14 30% 62%)`, `s1` `hsl(14 18% 62%)`
- dark steps: `d3` `hsl(14 54% 48%)`, `d2` `hsl(14 54% 38%)`, `d1` `hsl(14 54% 28%)`

Every other hue follows the same formula with its own hue number.

A tag string maps deterministically to a hue via an FNV hash, `tag-${(seed % 12) + 1}` (see `tagHueToken` in `lib/textures.ts`), so a given tag always renders the same color.

## Pattern colors (runtime token picks)

From `lib/pattern-meta.ts`. Patterns store CI-Hub token keys (e.g. `chart-1`), never hex, so they stay on the design system and flip with theme.

Core (teal-first, the main interaction family): `primary` (Primary), `chart-1` (Mint), `chart-3` (Aqua), `chart-4` (Steel), `chart-5` (Navy).

Tag hues: the 12 `tag-1` through `tag-12` listed above.

Base tag defaults: `community` uses `primary`, `home` uses `chart-1`, `work` uses `chart-4`.

## Hard-coded colors in component styles

A few values are intentionally fixed (constant across modes) in `index.css`:

- Signature mint CTA gradient (`.btn-primary`, `.fab`, `.checkbox-checked`): `linear-gradient(135deg, #58ebbf, #409b9b)` with dark text `#041620`. Hover shifts to `linear-gradient(135deg, #82ffe1, #58ebbf)`.
- Active nav item: text `#58ebbf` with a `2px solid #58ebbf` left border.
- Priority dots: `p1` `#ef4444`, `p2` `#f97316`, `p3` `#58ebbf`, `p4` `#409b9b`, `p5` `#244859` (each with a matching glow shadow).
- Glow shadows throughout use `rgba(88,235,191,...)` (the mint `#58ebbf`), e.g. `shadow-glow-ci` `0 0 20px -4px rgba(88,235,191,.35)`.
- Modal backdrop: `rgba(0,0,0,.7)`.
- Badge tints: green on `rgba(88,235,191,.12)`, yellow on `bg-yellow-900/40` text `yellow-400`, red on `bg-red-900/40` text `red-400`.

## Legacy scale remaps

To keep older utilities themeable, `tailwind.config.js` remaps:

- `surface-950/900/800/700/600/500` onto `--background` / `--sidebar` / `--card` / `--border` / `--input`.
- `slate-*` text shades onto themed text tokens (50 to 200 prominent headings, 300 to 400 body, 500 to 700 muted, 800 to 950 backgrounds).

## Typography note

Font family is Montserrat across the org (`sans` and `heading`), with `Source Code Pro` as the mono fallback.
