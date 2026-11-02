# planning.ci.computer

Static site for Companion Planning, deployed to Cloudflare Pages at
`planning.ci.computer`. It is plain HTML and CSS with no build step and no external
requests. Fonts are the system stack and every image is served from this site.

## What's here

- `index.html` — home page: what the planner is, features, setup in three steps,
  screenshots, where to get it, data and privacy, and a short FAQ.
- `setup/index.html` — the Docker setup guide.
- `faq/index.html` — the full FAQ.
- `support/index.html` — how to get help.
- `404.html` — not-found page (noindex).
- `assets/site.css` — the one stylesheet. Colours follow the CI canon: `--primary` is
  phthalo `#0a6358` in light mode and sage `#c5e8dc` in dark mode.
- `img/` — screenshots from `docs/ui/`, resized to 1440 px wide and encoded as WebP.
  Each image has a light and a dark version, and `<picture>` picks by colour scheme.
- `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` — copied from
  `client/public/`, so the site and the app share one icon.
- `og-image.png` — 1200 × 630 social card. Source: `design/planning-site/og.html`.
- `sitemap.xml`, `robots.txt` — keep `lastmod` current when a page changes.
- `llms.txt` — a plain-text summary for AI assistants. Keep its page list in step
  with the pages.
- `oembed.json` — oEmbed "link" response for the home page, advertised with a
  `rel="alternate"` link in the home page head. It is a static file, so it answers
  for any `?url=` query. That is correct while the home page is the only embeddable
  page.
- `_headers` — security headers and cache rules. Cloudflare Pages applies them only
  when the site is deployed.

## Store links

The App Store and Google Play entries are text placeholders marked "coming soon".
When a listing is live, replace the placeholder spans in `index.html` with links to
the listing. Update the `sameAs` list in the JSON-LD on the home page to match.

## Regenerate the social card

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --hide-scrollbars --window-size=1200,630 --force-device-scale-factor=1 \
  --screenshot="$PWD/site/og-image.png" "file://$PWD/design/planning-site/og.html"
```

## Checks before you deploy

```bash
python3 -m http.server 8791 --bind 127.0.0.1 --directory site   # then open http://127.0.0.1:8791/
xmllint --noout site/sitemap.xml
python3 -c 'import json; json.load(open("site/oembed.json"))'
```

## Deploy

The Pages project is `ci-planning`, and `wrangler.toml` at the repository root points
it at this directory. The workflow `.github/workflows/deploy-planning-site.yml` deploys
on every push to `main` that touches `site/**`. That workflow needs two repository
secrets, `CLOUDFLARE_API_TOKEN` (Pages:Edit) and `CLOUDFLARE_ACCOUNT_ID`.

Manual deploy, after `wrangler login`:

```bash
npx wrangler pages deploy site --project-name=ci-planning --branch=main
```

`--branch=main` makes the deploy a production deployment, which is the one that
serves the custom domain.
