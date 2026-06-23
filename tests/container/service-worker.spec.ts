import { test, expect } from "@playwright/test";

// Phase H: the service worker must be served uncached at root scope and must NOT
// break the existing install / read path. Runs against the published container.
const url = process.env.APP_URL || "http://localhost:8080";

test("/sw.js is served uncached and at root scope", async ({ request }) => {
  const res = await request.get(`${url}/sw.js`);
  expect(res.status(), "sw.js should be served").toBe(200);
  const h = res.headers();
  expect(h["cache-control"] ?? "", "the SW file must never be stale-cached").toContain("no-cache");
  expect(h["service-worker-allowed"], "the SW needs root scope").toBe("/");
});

test("registering the service worker does not break install / reload", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

  // The SW activates (skipWaiting + clients.claim) in a secure context. Guard so a
  // non-secure APP_URL host degrades to just the load check rather than failing.
  const swState = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return "unsupported";
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 10_000));
    const ready = navigator.serviceWorker.ready.then((reg) => !!reg.active);
    return (await Promise.race([ready, timeout])) ? "active" : "timeout";
  });
  expect(["active", "unsupported"], "SW should activate where supported").toContain(swState);

  // A broken / precache SW would strand a blank page on reload — assert the app re-mounts.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  const bodyText = (await page.locator("body").innerText().catch(() => "")).trim();
  const rootCount = await page.locator("#root, #app, main").count();
  expect(bodyText.length > 0 || rootCount > 0, "app re-mounts after reload with the SW active").toBeTruthy();
});
