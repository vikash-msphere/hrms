import type { Page } from "@playwright/test";
import { test, expect, gotoRoute, makeThrowawayPerson, retireThrowawayPerson, allowConsoleErrors } from "./fixtures";

// The app lock (app-lock-plan.md) end to end, on a login of its own: a PIN on one of the seeded five would lock
// every other worker's browser signed in as them.
//
// What is being proved is the whole promise, not the screen: once locked, the SERVER refuses the browser, a
// reload stays locked, the other tabs lock with it, and only the PIN opens it again.

const PIN = "482916";

// A request made FROM THE PAGE, the way the app makes it. Not `page.request`: the unlock proof is a
// SameSite=Strict cookie, which Playwright's side-channel request context does not send, so a check made through
// it would be asking about a browser that is not the one on screen.
async function inPage(page: Page, path: string, method = "GET", body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return page.evaluate(
    async ([p, m, b]) => {
      const res = await fetch(p, { method: m, credentials: "include", headers: { "X-Requested-By": "hrms-spa", "Content-Type": "application/json" }, ...(b ? { body: b } : {}) });
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    },
    [path, method, body === undefined ? "" : JSON.stringify(body)] as const,
  );
}

test("a PIN locks the browser: the server refuses it, a reload stays locked, and the PIN opens it", async ({ as }) => {
  const admin = await as("super");
  const person = await makeThrowawayPerson(admin, "Lock");
  try {
    const page = await as({ email: person.email });
    // Every /v1 read of a locked browser is refused (that is the point), and a wrong PIN is a refusal too.
    allowConsoleErrors(page, /status of 401/);
    allowConsoleErrors(page, /status of 403\b.*\/auth\/lock\/unlock/);
    await gotoRoute(page, "dashboard");

    // Set it up from the top bar, the way somebody meeting it for the first time would.
    await page.getByRole("button", { name: "Set up app lock" }).click();
    const sheet = page.getByRole("dialog", { name: "App lock" });
    await sheet.getByRole("button", { name: /6 digits/ }).click();
    await sheet.getByLabel("Choose a 6-digit PIN").fill(PIN);
    await sheet.getByLabel("Enter it again").fill(PIN);
    await expect(sheet.getByText("Your PIN is set.")).toBeVisible();

    // A second tab of the same browser, open on the app, must lock along with this one.
    const other = await page.context().newPage();
    await other.goto("/dashboard");
    await expect(other.getByRole("main")).toBeVisible({ timeout: 30_000 });

    await sheet.getByRole("button", { name: "Lock now" }).click();
    await expect(page.getByRole("heading", { name: /Welcome back|is locked/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("main")).toHaveCount(0);
    await expect(other.getByRole("heading", { name: /Welcome back|is locked/ })).toBeVisible({ timeout: 30_000 });

    // The server is the lock, whatever the page shows.
    const me = await inPage(page, "/v1/users/me");
    expect(me.status).toBe(401);
    expect(me.json?.type).toBe("/errors/app-locked");

    // A reload is still the lock screen, never the app.
    await page.reload();
    await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible({ timeout: 30_000 });

    // A wrong PIN is counted and said so.
    await page.getByLabel("Enter your 6-digit PIN").fill("905172");
    await expect(page.getByText(/Wrong PIN\. 4 tries left/)).toBeVisible();

    // The right one opens it - and the other tab comes back with it.
    await page.getByLabel("Enter your 6-digit PIN").fill(PIN);
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
    await expect(other.getByRole("main")).toBeVisible({ timeout: 30_000 });
    expect((await inPage(page, "/v1/users/me")).status).toBe(200);
    await other.close();
  } finally {
    await retireThrowawayPerson(admin, person.path);
  }
});

test("the lock closes by itself after the person's own auto-lock time", async ({ as }) => {
  const admin = await as("super");
  const person = await makeThrowawayPerson(admin, "Idle");
  try {
    const page = await as({ email: person.email });
    allowConsoleErrors(page, /status of 401/);
    // Set up through the API: the setup screen is the other test's subject; this one is about the timer. From a
    // static file of the app's own origin, so the requests are same-site like the app's and no app is running to
    // race them - a PIN appearing behind a live page's back is exactly what the page must answer by locking.
    await page.goto("/favicon.svg");
    const set = await inPage(page, "/auth/lock/pin", "PUT", { pin: PIN });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect((await inPage(page, "/auth/lock", "PATCH", { idle_minutes: 5 })).status).toBe(200);

    await page.clock.install();
    await gotoRoute(page, "dashboard");
    // The warning comes first, in the last 30 seconds...
    await page.clock.fastForward("04:40");
    await expect(page.getByText(/Locking in \d+s/)).toBeVisible();
    // ...and then the lock, with nobody having touched anything.
    await page.clock.fastForward("00:30");
    await expect(page.getByRole("heading", { name: /Welcome back|is locked/ })).toBeVisible({ timeout: 30_000 });
  } finally {
    await retireThrowawayPerson(admin, person.path);
  }
});
