import { test, expect } from "@playwright/test";

// Track C3 — the two login paths, driven in the published container. Each path needs
// its own container (see docker-publish.yml "Start login containers"), so the spec is
// selected by LOGIN_SPEC and skips itself otherwise; a plain `npx playwright test`
// (the standalone screenshot gate) runs neither.
//
//   LOGIN_SPEC=local  → container in AUTH_MODE=sso + DISABLE_OIDC=true, seeded from
//                       AUTH_DEFAULT_*; LOGIN_USER / LOGIN_PASS carry the pair.
//   LOGIN_SPEC=portal → container in AUTH_MODE=sso pointed at the repo's fixture portal
//                       (src/scripts/fixture-portal.ts) with AUTH_AUTO_PROVISION=true.
const url = process.env.APP_URL || "http://localhost:8080";
const spec = process.env.LOGIN_SPEC;

async function expectSignedIn(page: import("@playwright/test").Page) {
  // The login flows end in a full-document load of "/", and the shell mounts only
  // once /api/auth/me answers 200 for the session cookie.
  await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 30_000 });
  await expect(page.locator("[data-app-shell]")).toBeVisible({ timeout: 30_000 });
  const me = await page.request.get(`${url}/api/auth/me`);
  expect(me.status(), "the session cookie must authenticate /api/auth/me").toBe(200);
}

test.describe("local username/password login", () => {
  test.skip(spec !== "local", "set LOGIN_SPEC=local against a DISABLE_OIDC=true container");

  test("signs in with the seeded operator and reaches the app", async ({ page }) => {
    const user = process.env.LOGIN_USER || "smoke-admin";
    const pass = process.env.LOGIN_PASS || "smoke-password-123";

    expect((await page.request.get(`${url}/api/auth/me`)).status(), "unauthenticated /me is 401").toBe(401);

    await page.goto(`${url}/login`, { waitUntil: "domcontentloaded" });
    // Newer builds show the form behind "Sign in with username instead" when the
    // portal is also on; in a DISABLE_OIDC container it renders directly. Click the
    // expander only if it is there.
    const expander = page.getByRole("button", { name: /sign in with username instead/i });
    if (await expander.isVisible({ timeout: 3_000 }).catch(() => false)) await expander.click();

    await page.getByLabel(/^username/i).fill(user);
    await page.getByLabel(/^password/i).fill(pass);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expectSignedIn(page);
  });

  test("rejects a wrong password with a generic error and no session", async ({ page }) => {
    const res = await page.request.post(`${url}/api/auth/login`, {
      data: { username: process.env.LOGIN_USER || "smoke-admin", password: "definitely-wrong" },
    });
    expect(res.status()).toBe(401);
    expect((await page.request.get(`${url}/api/auth/me`)).status()).toBe(401);
  });
});

test.describe("Companion Portal login (fixture portal)", () => {
  test.skip(spec !== "portal", "set LOGIN_SPEC=portal against a container wired to the fixture portal");

  test("the Portal button round-trips through the fixture and signs in", async ({ page }) => {
    await page.goto(`${url}/login`, { waitUntil: "domcontentloaded" });
    // "Continue with CI-Portal" before the Companion Portal rename, "Continue with
    // Companion Portal" after it — the gate must pass across that merge.
    await page.getByRole("link", { name: /continue with (ci-|companion )portal/i }).click();

    // The fixture's consent page.
    await expect(page).toHaveTitle(/portal \(fixture\)/i, { timeout: 30_000 });
    await page.getByRole("link", { name: /^continue as/i }).click();

    // Newer builds confirm before provisioning a brand-new portal identity (B3);
    // older ones land straight in the app. Accept either.
    const create = page.getByRole("button", { name: /create account/i });
    if (await create.isVisible({ timeout: 5_000 }).catch(() => false)) await create.click();

    await expectSignedIn(page);
    const me = (await (await page.request.get(`${url}/api/auth/me`)).json()) as { name: string };
    expect(me.name).toBe("Avery Fixture"); // the fixture's default identity
  });

  test("a replayed callback is refused", async ({ page }) => {
    // Start a flow, capture the callback the fixture bounces to, consume it once, then
    // replay it: the state row is single-use and the second hit must be a 400.
    await page.goto(`${url}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /continue with (ci-|companion )portal/i }).click();
    await expect(page).toHaveTitle(/portal \(fixture\)/i, { timeout: 30_000 });
    const approve = await page.getByRole("link", { name: /^continue as/i }).getAttribute("href");
    const fixtureOrigin = new URL(page.url()).origin;
    const bounce = await page.request.get(`${fixtureOrigin}${approve}`, { maxRedirects: 0 });
    const callback = bounce.headers()["location"];
    expect(callback, "the fixture must redirect to the app callback").toMatch(/\/api\/auth\/ciportal\/callback\?/);
    const first = await page.request.get(callback, { maxRedirects: 0 });
    expect([302, 200]).toContain(first.status());
    const replay = await page.request.get(callback, { maxRedirects: 0 });
    expect(replay.status()).toBe(400);
  });
});
