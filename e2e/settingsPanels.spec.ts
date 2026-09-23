import { gotoRoute, test, expect, toast } from "./fixtures";

// Every org settings panel that SAVES, saving.
//
// `everySetting` proves each panel opens; `catalogEditors` proves the row-based ones take a row. This is the
// third kind: the panels that edit one org-wide blob (the attendance schedule, the payroll policy, the
// notification config…). They all have the same failure mode and it is a quiet one - the form renders, the
// Save button is right there, and the value never comes back. Nobody notices until somebody wonders why
// their org still behaves the old way.
//
// So: change ONE toggle, save, reload the panel from cold, and require the new value to be what the panel
// draws. Then put it back, because these settings change how the whole app behaves for every other spec.
// `checkbox` picks WHICH toggle to flip, for the panels whose first one belongs to another spec. Default 0.
const PANELS: { key: string; title: string; checkbox?: number }[] = [
  { key: "identity", title: "Name & branding" },
  // Not the first checkbox. That one is `settings/holidays.feed_enabled`, which `calendarFeed.spec.ts` turns
  // ON for its own run - so this flipped it, saved it (200), and read back the other spec's value a moment
  // later, reporting a panel that saves perfectly well as one that "did not keep the change". The second,
  // `comp_off_on_holiday_work`, is on the same blob and the same Save, so the round trip this is here to
  // prove is unchanged - it just belongs to nobody else. Skipping the panel outright (as `attendance` and
  // `dashboard` are) would have given that up for no reason.
  { key: "defaults", title: "Probation & holiday defaults", checkbox: 1 },
  { key: "employee-ids", title: "Employee IDs" },
  { key: "employee-fields", title: "Employee identity fields" },
  { key: "leave-policy", title: "Leave policy" },
  { key: "attendance", title: "Attendance schedule" },
  { key: "payroll-policy", title: "Payroll policy" },
  { key: "expenses", title: "Expenses" },
  // `reimbursements` is deliberately absent: its payout choice is committed by pressing the mode itself
  // (there is nothing to "save"), and its categories are covered by `catalogEditors`.
  { key: "recruiting", title: "Recruiting pipeline" },
  { key: "referrals", title: "Referral bonuses" },
  { key: "notifications", title: "Notifications" },
  { key: "esign", title: "E-signature" },
  { key: "ticket-categories", title: "Ticket categories" },
  { key: "kudos", title: "Kudos levels" },
  { key: "quick-actions", title: "Quick create menu" },
  { key: "dashboard", title: "Dashboard visibility" },
  { key: "asset-tags", title: "Asset tags" },
];

test("every settings panel offers a save, and the one that takes a toggle keeps it", async ({ as }) => {
  test.setTimeout(600_000);
  const page = await as("super");
  const failures: string[] = [];

  for (const panel of PANELS) {
    let flipped: boolean | null = null; // the value this test left in the org, if it changed one

    try {
      await gotoRoute(page, `settings/${panel.key}`);
      await expect(page.locator("h1").first()).toHaveText(panel.title, { timeout: 15_000 });

      // A panel that edits a blob has a save. Its absence is the bug this list is here to catch: a form with
      // no way to commit it.
      const save = page.getByRole("button", { name: /^Save/ }).first();
      await expect(save, `${panel.key} has no save`).toBeVisible({ timeout: 15_000 });

      // The round trip, on the first switch the panel offers. A panel with no switch is skipped rather than
      // faked: its own spec owns it (`holidays`, `catalogEditors`, `accessAdmin`).
      // `isChecked` rather than an attribute: some panels use a native checkbox and some a Radix one, and
      // the round trip is the same question either way.
      // `attendance` is deliberately read-only here: its first switch is a WORKING DAY, and a week with
      // Sunday in it changes every leave, attendance and payroll number the specs after this one assert.
      //
      // `dashboard` for the same reason: its first switch takes a KPI card or a whole band off every
      // dashboard in the org, and it stays off across a save, a reload and a restore - long enough for a
      // spec reading somebody's dashboard in parallel to find a card that ships visible simply absent.
      // Nothing is lost by skipping it: `kpiVisibility.spec.ts` drives this exact panel, saves it, and polls
      // the stored blob to prove the round trip - which is more than the flip below would have shown.
      if (panel.key === "attendance" || panel.key === "dashboard") continue;

      const toggle = page.getByRole("checkbox").nth(panel.checkbox ?? 0);
      // Waited for, not counted immediately: these panels fetch their blob after mount, so a count taken on
      // the first paint is 0 and the round trip would be skipped silently.
      const hasToggle = await toggle.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
      if (!hasToggle) continue;
      // Waited until the value HOLDS STILL before touching it. These panels paint their defaults and fill
      // them in from the stored blob a moment later - the restore block below already polls for exactly that
      // - so a flip landing inside that window is a click the refill then overwrites, and the assertion right
      // after it fails on a panel that takes the change perfectly well.
      await expect.poll(async () => {
        const first = await toggle.isChecked();
        await page.waitForTimeout(400);
        return first === (await toggle.isChecked());
      }, { timeout: 15_000 }).toBe(true);
      const before = await toggle.isChecked();
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: !before });
      // Waited on the WRITE, not on the click: a reload that races the request in flight loses the change and
      // makes a panel that saves perfectly well look broken.
      await Promise.all([writeLanded(page), save.click()]);
      flipped = before;

      await page.reload();
      await expect(page.locator("h1").first()).toHaveText(panel.title, { timeout: 15_000 });
      await expect(page.getByRole("checkbox").nth(panel.checkbox ?? 0), `${panel.key} did not keep the change`).toBeChecked({ checked: !before, timeout: 15_000 });
    } catch (e) {
      failures.push(`${panel.key}: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      // Put it back WHATEVER happened above. These are org-wide settings - an employee ID format or a leave
      // policy left flipped by a failed assertion changes how the app behaves for every spec that runs after
      // this one, which turns one failure into twenty.
      if (flipped !== null) {
        try {
          await gotoRoute(page, `settings/${panel.key}`);
          const box = page.getByRole("checkbox").nth(panel.checkbox ?? 0);
          await expect(box).toBeVisible({ timeout: 15_000 });
          // Polled rather than read once: the panel paints its defaults and fills them in from the stored blob
          // a moment later, so an immediate read sees the default and "puts back" the wrong value.
          await expect.poll(() => box.isChecked().catch(() => null), { timeout: 15_000 }).toBe(!flipped);
          await box.click();
          await Promise.all([writeLanded(page), page.getByRole("button", { name: /^Save/ }).first().click()]);
          await page.reload();
          await expect(page.getByRole("checkbox").nth(panel.checkbox ?? 0), `${panel.key} could not be put back`).toBeChecked({ checked: flipped, timeout: 15_000 });
        } catch (e) {
          failures.push(`${panel.key} (restore): ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
  }

  expect(failures, `settings panels that would not save:\n${failures.join("\n")}`).toEqual([]);
});

/**
 * The panel's own write, CONFIRMED - the app's success toast, or the settings PATCH behind it.
 *
 * Reloading into the request in flight loses the change and makes a panel that saves perfectly well look
 * broken, and there is no single request shape to wait for: most panels PATCH one settings blob, a few write
 * elsewhere, and the batched reader (`POST /v1/batch:run`) is far too noisy to match loosely. The toast is
 * the app saying the write came back, so whichever arrives first ends the wait.
 */
async function writeLanded(page: import("@playwright/test").Page) {
  const said = toast(page, /saved|updated/i)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  const patched = page
    .waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/v1/settings/") && r.status() < 400, { timeout: 10_000 })
    .catch(() => undefined);
  await Promise.race([said, patched]);
  // The store folds the response back on the next tick; reloading inside that window is the same race again.
  await page.waitForTimeout(500);
}
