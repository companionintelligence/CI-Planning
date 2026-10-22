import { test, expect } from "@playwright/test";

// Track D2 — the security headers the server sets on every response. Runs in every
// container phase (no LOGIN_SPEC gate): the shell at "/" and an API route.
const url = process.env.APP_URL || "http://localhost:8080";

test("the SPA shell and the API carry the security headers", async ({ request }) => {
  for (const path of ["/", "/api/health"]) {
    const res = await request.get(`${url}${path}`);
    const h = res.headers();
    expect(h["x-content-type-options"], `${path}: nosniff`).toBe("nosniff");
    expect(h["referrer-policy"], `${path}: referrer policy`).toBe("strict-origin-when-cross-origin");
    expect(h["x-frame-options"], `${path}: framing`).toBe("DENY");
    expect(h["content-security-policy"], `${path}: CSP present`).toContain("default-src 'self'");
    expect(h["content-security-policy"], `${path}: no inline scripts`).not.toContain("script-src 'self' 'unsafe-inline'");
    // Plain HTTP in the smoke test ⇒ no HSTS (it is only sent over HTTPS).
    expect(h["strict-transport-security"], `${path}: no HSTS over http`).toBeUndefined();
  }
});

test("the shell still renders under the policy (no CSP violations on load)", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  expect(violations, "CSP must admit the app's own scripts, styles, fonts and workers").toEqual([]);
});
