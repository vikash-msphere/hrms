import { defineConfig, devices } from "@playwright/test";
import { lane } from "./e2e/lane";

// The browser lane. Deliberately small, and deliberately NOT part of `npm run verify`.
//
// `npm run verify` (spectral -> tsc -> vitest) is the gate that blocks every commit, and it has to stay fast
// and boring. What this lane adds is the one thing vitest cannot reach: the React app actually running. The
// 165 vitest files already drive the Worker through `app.fetch` with real authz and a real D1, and the source
// scans (test/responsiveCoverage.test.ts, test/confirmCoverage.test.ts, …) already pin the front-end
// conventions in the SOURCE. Neither of them can tell you the app renders, that a dialog's submit posts the
// right payload, that the resource store invalidates after a write, or that a page threw in the console.
//
// So a spec here earns its place only by asserting something a browser is required to observe. Business
// logic belongs in the vitest suite, where it is cheaper and stricter. See docs/04-testing.md.
//
// The stack is the dev stack's shape - Vite in front, `/v1` through the Prism contract proxy, then the Worker
// - so a request or response that drifts from openapi.yaml fails the browser test where it happens.
// Ports, database and artifacts all come off ONE knob (`E2E_LANE`), so a second run on this machine is a
// second stack rather than a second writer of the first one's. See e2e/lane.ts.
const baseURL = process.env.E2E_BASE ?? `http://127.0.0.1:${lane.webPort}`;

export default defineConfig({
  testDir: "e2e",
  // Per lane: Playwright EMPTIES this at the start of a run, so two lanes sharing it means the second one
  // deletes the first's traces and error contexts while that run is still producing them.
  outputDir: lane.outputDir,
  // Proves the stack is in the mode the specs assume (Google cookie auth, dev bypass off) before anything runs.
  globalSetup: "./e2e/globalSetup.ts",
  // One local D1 file, one Worker: parallel specs writing the same rows race each other, so the number here
  // is a measured ceiling rather than a machine count. 16 is it. Past that the Vite dev server stops
  // answering under the load and whole swathes of the run fail with ECONNREFUSED on the SPA port - failures
  // that say nothing about the app and make the run void. Specs sharded with per-spec data could raise it.
  workers: 16,
  fullyParallel: false,
  // A retry earns its keep here: the failure that repeats is real, and the trace from the retry is how it
  // gets diagnosed. `forbidOnly` keeps a stray `test.only` from silently shrinking the CI run to one spec.
  retries: process.env.CI ? 2 : 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    video: "on-first-retry",
    // Tight enough that a hung selector fails as a test rather than as a timed-out run.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // launchOptions: {
    //   slowMo: 1000,
    // },
  },
  projects: [
    {
      name: "desktop",
      testIgnore: ["**/phone.spec.ts", "**/wide.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // Locally: the system Chrome that scripts/uiShots.mjs already drives, so nothing extra is downloaded.
        // In CI: the bundled chromium from `npx playwright install chromium`.
        channel: process.env.E2E_CHANNEL ?? (process.env.CI ? undefined : "chrome"),
      },
    },
    {
      // The phone. `isMobile` + `hasTouch` are what make `matchMedia("(pointer: coarse)")` true, without which
      // every `coarse:` rule in the app is absent and the measurements are of the desktop rendering wearing a
      // narrow viewport - the exact mistake docs/06-responsive-ui.md warns about.
      name: "phone",
      testMatch: "**/phone.spec.ts",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 390, height: 844 },
        channel: process.env.E2E_CHANNEL ?? (process.env.CI ? undefined : "chrome"),
      },
    },
    {
      // A wide desktop, for the wide-screen layout rules (docs/06-responsive-ui.md, "Wide screens"): every one
      // of them keys off a width past 1440, so the `desktop` project above cannot see any of it - and is, by the
      // same rule, a baseline that none of it changes. 2560 is past both `3xl` (1920) and the width at which
      // `<main>`'s 1920px cap binds (~2176).
      name: "wide",
      testMatch: "**/wide.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 2560, height: 1440 },
        channel: process.env.E2E_CHANNEL ?? (process.env.CI ? undefined : "chrome"),
      },
    },
  ],
  webServer: {
    command: "scripts/e2eStack.sh",
    url: `${baseURL}/`,
    // Cold start does a DB reset + migrations + seed, then boots three processes; Vite compiles the app on
    // the first request rather than up front.
    timeout: 300_000,
    // Locally, attach to a stack you already have running (the ports are e2e-only, so this can never latch
    // onto the dev stack and its single bypass identity). In CI, always start a clean one.
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
