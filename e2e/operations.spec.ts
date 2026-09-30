import { gotoRoute, test, expect, toast } from "./fixtures";

// The scheduled tasks page, and running one by hand.
//
// Crons are the part of the system nobody watches until something silently stops: leave stops accruing,
// payslip PDFs never appear, reminder emails go quiet. The page exists to make that visible - what each task
// does, when it last ran, when it runs next - and to let an admin force one now rather than waiting for the
// clock. `test/cron.test.ts` owns what each task DOES; what only the browser proves is that "Run now"
// actually reaches the worker and that the card then reads back the tick it produced instead of still
// saying "Never run".
test("a scheduled task is run by hand, and the page reads back the tick", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  await gotoRoute(page, "settings/operations");
  await expect(page.locator("h1").first()).toHaveText("System operations");

  // The job drainer: the safest task to force, and the one whose absence explains most "where is my PDF"
  // questions - it is what turns a published payroll run into downloadable payslips.
  await expect(page.getByText("Job drainer")).toBeVisible();
  const neverRun = page.getByText("Never run");
  const unrunBefore = await neverRun.count();
  const drainer = page.getByRole("button", { name: "Run now" }).first();
  await expect(drainer).toBeEnabled();
  await drainer.click();

  // The tick, read back: one fewer card saying "Never run", because that card now has a status and a
  // "just now" instead. (The other task keeps its own state - this is one task running, not a page reset.)
  // (On a re-run against a warm database the drainer already has a tick, and the count starts lower.)
  if (unrunBefore > 0) await expect(neverRun).toHaveCount(unrunBefore - 1, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Run now" }).first()).toBeEnabled({ timeout: 30_000 });

  // And the other tasks are still offered rather than the page turning into a one-shot.
  await expect(page.getByText("AI drains")).toBeVisible();
  await expect(page.getByText("Daily maintenance")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(3);

  // Refresh re-reads both lists in place - the page never navigates, so a broken reload looks like a page
  // that simply never updates again.
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await expect(page.getByText("Scheduled tasks")).toBeVisible();
});

// Clearing the server caches by hand. `test/cacheFlush.test.ts` owns what the flush DOES (every counter moves,
// the answering instance empties); what only the browser proves is that the button reaches the worker and the
// page says what happened - including that the other servers follow within seconds rather than at once.
test("server caches are cleared by hand, and the page says every server follows", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "settings/operations");
  await expect(page.getByRole("heading", { name: "Server caches" })).toBeVisible();
  await page.getByRole("button", { name: "Clear caches" }).click();
  // The answer is a toast, and Radix repeats its text in a screen-reader announcer: look in the toast itself.
  const cleared = toast(page, "Caches cleared");
  await expect(cleared).toBeVisible();
  await expect(cleared).toContainText("Every server reloads within about 5 seconds.");
  // Still usable afterwards: the page that asked is served by an instance that has just emptied every cache.
  await expect(page.getByRole("button", { name: "Clear caches" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(3);
});
