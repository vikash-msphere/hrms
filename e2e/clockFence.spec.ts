import { allowConsoleErrors, gotoRoute, test, expect, toast, ymd } from "./fixtures";

// The way out of the attendance clock's network fence.
//
// The fence itself is server logic and is pinned in vitest (test/attendanceClockFence.test.ts): who is
// admitted, that approved remote work eases it for exactly its dates, and that the refusal carries the
// problem type `/errors/clock-network-fence`. None of that needs a browser.
//
// What DOES need one is what the app makes of that refusal. An off-network punch is the single clock failure
// with something to do about it, so instead of a dead-end toast the app offers to file the remote-work
// request and - on yes - lands the person in the form. Three separate pieces have to agree for that to
// happen (web/src/lib/clock.tsx branches on the type, web/src/api.ts must NOT also fire its "request access"
// offer, and the intent bus has to survive the navigation and open RemoteWork's dialog on mount), and no
// unit test can see all three at once.
//
// The 403 is stubbed rather than provoked: the fence keys on `cf-connecting-ip`, which is exactly the header
// a browser cannot choose, and configuring a real fence on the e2e stack would refuse every punch in
// clock.spec.ts too. The stub's body is the shape the server actually sends - the vitest test above pins
// status and type, and problemText's copy is pinned in test/problemText.test.ts - so this spec is left
// asserting only the part that is genuinely the browser's.

const FENCE_BODY = {
  type: "/errors/clock-network-fence",
  title: "Permission Denied",
  status: 403,
  detail: "attendance clock in/out is only allowed from an approved network, or during approved remote work",
};

/** Answer the clock-in punch the way an off-network Worker would. */
async function fenceThePunch(page: Parameters<typeof gotoRoute>[0]) {
  // The refused punch is the POINT of these specs, and the browser logs every 403 it receives - so the
  // console watchdog is told to expect this one rather than failing the test at teardown.
  allowConsoleErrors(page, /status of 403/);
  await page.route(
    (url) => url.pathname.endsWith("/attendance/me:clockIn"),
    (route) => route.fulfill({ status: 403, contentType: "application/problem+json", body: JSON.stringify(FENCE_BODY) }),
  );
}

/**
 * The top bar's "Clock in", once it is the punch on offer.
 *
 * This person is on the clock for a few seconds while `clock.spec.ts` runs, and the bar then reads "Clock
 * out" instead. The state is read when the page loads, so the page is re-read until the punch this spec is
 * about is the one being offered. Nothing here clocks anybody in or out: the punch is stubbed to a refusal,
 * and taking a shared person off the clock to suit this test would break the spec that is using them.
 */
function offeredClockIn(page: import("@playwright/test").Page) {
  const punch = page.getByRole("banner").getByRole("button", { name: /^Clock in$/ });
  return {
    async click() {
      await expect(async () => {
        if (!(await punch.count())) await page.reload();
        await expect(punch).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 90_000 });
      await punch.click();
    },
  };
}

test("an off-network punch offers the remote-work request and opens the form", async ({ as }) => {
  const page = await as("employee");
  await fenceThePunch(page);
  await gotoRoute(page, "dashboard");

  await offeredClockIn(page).click();

  // Not a toast. The refusal is a question, because the answer is a request the person can file right now.
  const offer = page.getByRole("dialog").filter({ hasText: "You're not on a work network" });
  await expect(offer).toBeVisible();

  // The 403 must NOT also raise the shell's permission-wall offer (web/src/api.ts): this caller holds
  // `attendance.clockIn` perfectly well, so "ask the access admins for attendance" would send them to
  // somebody who cannot help - and it would land on top of the dialog above.
  await expect(toast(page, /don't have access/i)).toHaveCount(0);

  await offer.getByRole("button", { name: "Request remote work" }).click();

  // Confirming lands in the FORM, not merely on the page - the intent has to outlive the navigation.
  // Asserted by URL rather than by the page's <h1>: the form is a modal, so the page behind it is
  // `aria-hidden` and its heading is (correctly) out of the accessibility tree while the dialog is open.
  await expect(page).toHaveURL(/\/remote-work$/);
  const form = page.getByRole("dialog").filter({ hasText: "Request remote work" });
  await expect(form).toBeVisible();

  // Dated today, so the common case (I am at home right now) needs only a reason. Reached BY LABEL, which is
  // also the assertion that <Field> binds its label to the control it names (components/common/Field.tsx):
  // located positionally this would pass just as well with every label in the app naming nothing.
  // The LOCAL day: the form offers "today" as the reader sees it, which is a different date from
  // `toISOString()` for part of every day in most timezones.
  const today = ymd();
  await expect(form.getByLabel("From")).toHaveValue(today);
  await expect(form.getByLabel("To")).toHaveValue(today);
  // The same binding on a control that is not an <input>: the employee picker is a Combobox, whose label
  // points at its trigger button.
  await expect(form.getByLabel("Employee")).toBeVisible();
});

test("declining the offer leaves you where you were, still clocked out", async ({ as }) => {
  const page = await as("employee");
  await fenceThePunch(page);
  await gotoRoute(page, "dashboard");

  const bar = page.getByRole("banner");
  await offeredClockIn(page).click();

  const offer = page.getByRole("dialog").filter({ hasText: "You're not on a work network" });
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toHaveCount(0);

  // Still on the dashboard, and the punch did NOT take: a refused clock-in that leaves the button saying
  // "Clock out" would be the app lying about where somebody is.
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Remote work");
  await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: /^Clock out/ })).toHaveCount(0);
});
