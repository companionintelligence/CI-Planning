import { defineConfig, devices } from "@playwright/test";

// Targets an already-running container (no webServer). The publish workflow
// starts the built image, then runs this against http://localhost:8080.
export default defineConfig({
  testDir: ".",
  // Keep browser checks selectable by purpose. Container startup/auth modes are
  // different fixtures, so CI and the local runner should invoke only the suite
  // that matches the container currently under test.
  projects: [
    {
      name: "smoke",
      testMatch: ["headers.spec.ts", "service-worker.spec.ts", "screenshot.spec.ts"],
    },
    {
      name: "auth-local",
      testMatch: "login.spec.ts",
      grep: /local username\/password login/,
    },
    {
      name: "auth-portal",
      testMatch: "login.spec.ts",
      grep: /Companion Portal login \(fixture portal\)/,
    },
    {
      name: "tasks",
      testMatch: "tasks-flow.spec.ts",
    },
    {
      name: "planner",
      testMatch: "planner-flow.spec.ts",
    },
    {
      name: "objectives",
      testMatch: "objectives-flow.spec.ts",
    },
    {
      name: "agent",
      testMatch: "agent-flow.spec.ts",
    },
    {
      name: "metrics",
      testMatch: "metrics-flow.spec.ts",
    },
    {
      name: "responsive",
      testMatch: "responsive-surfaces.spec.ts",
    },
    {
      name: "mobile",
      testMatch: "mobile-compartments.spec.ts",
    },
    {
      name: "accessibility",
      testMatch: "accessibility.spec.ts",
    },
  ],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    // The full Chromium build, not the "headless shell": the shell binary crashes at
    // launch on some Linux boxes (seen on the dev box with v1248), and the full build
    // runs these DOM tests identically. `playwright install chromium` provides both.
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : "chromium",
    baseURL: process.env.APP_URL || "http://localhost:8080",
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    // Software WebGL (SwiftShader) so three.js / WebGL apps actually render in
    // headless CI instead of producing a blank canvas. Harmless for DOM apps.
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--enable-webgl",
      ],
    },
  },
});
