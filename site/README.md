# planning.ci.computer

Static landing page for Companion Planning, deployed to Cloudflare Pages at
`planning.ci.computer`. It is plain HTML with inline CSS and no external
requests, so it works as a Pages "direct upload" project with no build step.

## What's here

- `index.html` — the whole page.
- `../wrangler.toml` — names the Pages project `ci-planning` and points at this directory.
- `../.github/workflows/deploy-planning-site.yml` — deploys this directory on every push to `main` that touches `site/**`.

## One-time setup (needs a Cloudflare account owner)

1. **Create the Pages project**, once:

   ```bash
   npx wrangler pages project create ci-planning --production-branch main
   ```

2. **Add two GitHub Actions secrets** on this repo
   (`companionintelligence/CI-Planning` → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — a token scoped to Cloudflare Pages:Edit for the account.
   - `CLOUDFLARE_ACCOUNT_ID` — the account that owns the `ci-planning` project and the `ci.computer` zone.
3. **Attach the custom domain**: in the Cloudflare dashboard, open Workers & Pages →
   `ci-planning` → Custom domains → add `planning.ci.computer`. Cloudflare creates the
   DNS record because `ci.computer` is already on Cloudflare.

## Manual deploy (no GitHub Actions)

From the repository root, after `wrangler login` (or with `CLOUDFLARE_API_TOKEN` set):

```bash
npx wrangler pages deploy site --project-name=ci-planning --branch=main
```

`--branch=main` makes the deploy a production deployment, which is the one that
serves the custom domain.
