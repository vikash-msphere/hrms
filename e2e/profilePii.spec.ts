import { allowConsoleErrors, gotoRoute, toast, test, expect } from "./fixtures";

// The two self-service panels on a person's own profile that nobody else fills in for them: government IDs,
// and the previous-employer income that keeps this year's tax projection honest.
//
// Both are `OWN_PII` (src/domain/grants.ts) - the owner and super, nobody in between - so both are done here
// by the person themselves. `test/employees.test.ts` owns the encryption and the masking; what only a browser
// has is the pair of forms: the identity editor refuses to save while a mandatory field is empty and SAYS
// which one, a sensitive value comes back masked with "leave blank to keep it", and the prior-income figure
// changes the projected tax on the same page it was typed on.
test.describe("own PII", () => {
  test("identity details are captured by their owner, on the fields the org asked for", async ({ as }) => {
    test.setTimeout(240_000);
    const admin = await as("super");
    const page = await as("employee");
    const label = `E2E ID ${Date.now() % 100000}`;
    // The 400 below is the FLOW, not a fault: the server refuses a removal that would strand employees'
    // stored values, the panel puts that refusal in front of the admin, and only the re-send carries the
    // confirmation. Reaching the second dialog therefore means logging one 400 on `settings/employee_fields`,
    // every time. Matched on the STATUS rather than the url because the tolerance patterns are tested against
    // the console message alone (fixtures.ts) - the url is appended only after that - and the message for a
    // failed resource load names no request. Scoped to the admin page, whose only write here is that key.
    allowConsoleErrors(admin, /status of 400 \(Bad Request\)/);
    // And the 409 the identity save retries through, on the employee's page: the refusal is the app being
    // right, but the browser logs every non-2xx fetch as a console error either way.
    allowConsoleErrors(page, /status of 409 \(Conflict\)/);
    // The signature card shares the Identity tab now, and it fetches whenever the employee record carries a
    // signature marker. `signature.spec.ts` uploads and then removes one on this same seeded employee, so a
    // page that read the record between those two moments asks storage for a file that is already gone. The
    // 404 is the stale marker, not a broken panel - and nothing this test asserts goes anywhere near it.
    allowConsoleErrors(page, /:getSignature/);

    // The identity card has no fields of its own: an org declares what it collects (PAN, Aadhaar, a passport
    // number), and the card is that list. So the field is declared first, by the only role that may.
    // Retried as a whole. This is ONE org-wide blob and `settingsPanels.spec.ts` saves the same panel, so a
    // save built on a snapshot that another spec has since replaced is refused by the settings compare-and-swap
    // - correctly, and with the added field simply not there afterwards. The answer is to take a fresh snapshot
    // (the reload) and add it again, which is what an admin who saw "couldn't save" would do.
    await expect(async () => {
      await gotoRoute(admin, "settings/employee-fields");
      await expect(admin.locator("h1").first()).toHaveText("Employee identity fields");
      await admin.getByRole("button", { name: "Add field" }).click();
      await admin.getByPlaceholder("e.g. Passport number").last().fill(label);
      await admin.getByRole("button", { name: "Save fields" }).click();
      // The press returns before the response does, so the reload below would abort the very write it is
      // about to check for. Wait on the outcome instead - and on either outcome, because a save refused by
      // the compare-and-swap is the expected case this loop exists to retry.
      await expect(toast(admin, /Employee fields saved|Couldn't save|changed this while/i)).toBeVisible({ timeout: 30_000 });
      await admin.reload();
      await expect(admin.getByPlaceholder("e.g. Passport number").last()).toHaveValue(label, { timeout: 30_000 });
    }).toPass({ timeout: 120_000 });

    // And the owner fills it in - nobody else may, `OWN_PII` being the point.
    await gotoRoute(page, "profile"); // one record page, two addresses: its `h1` is the person's name
    await page.getByRole("tab", { name: "Identity" }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText(label)).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: /^(Add|Edit)$/ }).first().click();

    const form = page.getByRole("dialog");
    await expect(form.getByText("Edit identity details")).toBeVisible();
    await form.getByLabel(label).fill("ABCDE1234F");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    // Retried through the CONFLICT, the same way profileNudges handles the emergency contact. Identity
    // details are a compare-and-swap over the whole blob on an employee these specs share, so losing that
    // race is the app being right: it re-reads, keeps what was typed, and says "check them and save again".
    // The dialog staying open IS that message - so waiting for it to close without answering it read as a
    // dialog that simply never closed, with a 409 in the worker log as the only trace.
    const conflict = form.getByText(/Somebody else changed these details/);
    await expect(async () => {
      if (await conflict.count()) await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });
    }).toPass({ timeout: 60_000 });

    // Read back on the card, and again from cold - an ID that has to be typed twice is an ID nobody types.
    await expect(panel.getByText("ABCDE1234F")).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.getByRole("tab", { name: "Identity" }).click();
    await expect(page.getByRole("tabpanel").getByText("ABCDE1234F")).toBeVisible({ timeout: 30_000 });

    // Take the field back off the org's list: every profile in the app shows it while it is there.
    // Retried for the same reason the add above is: the removal is a save of the same shared blob, and leaving
    // the field behind would put it on every profile in the app for the rest of the run.
    await expect(async () => {
      await gotoRoute(admin, "settings/employee-fields");
      // Ours is the row that was appended, so it is the last one - checked before it is removed, because
      // removing the last row blind would take somebody else's field off every profile in the org.
      await expect(admin.getByPlaceholder("e.g. Passport number").last()).toHaveValue(label, { timeout: 30_000 });
      const row = admin.locator("div").filter({ has: admin.getByPlaceholder("e.g. Passport number") }).last();
      await row.getByRole("button", { name: "Remove field" }).last().click();
      // Taking this field off the list is asked about TWICE, and neither dialog is optional here. First the
      // panel: a field that has already been SAVED takes every employee's stored value with it, so the row
      // does not vanish until that is confirmed (its confirm button carries the same name as the row's own,
      // hence the dialog scope). Then the SERVER refuses the save outright rather than stranding values, and
      // the panel puts that refusal - which names how many employees hold one - in front of the admin before
      // re-sending with the delete flag. This test fills the field in from the employee's side further up, so
      // the second dialog is guaranteed, and while it sat unanswered the save never landed at all.
      await answer(admin, "Remove field");
      await admin.getByRole("button", { name: "Save fields" }).click();
      await answer(admin, "Delete the values");
      // Waited on the SAVE, not on the dialog. Answering the second confirm is what sends the real write, and
      // the dialog closes on the press rather than on the response - so reloading as soon as it went away
      // aborted the PATCH it had just authorised, every time, and the field came back with the page.
      await expect(toast(admin, /Employee fields saved/)).toBeVisible({ timeout: 30_000 });
      await admin.reload();
      await expect(admin.getByPlaceholder("e.g. Passport number").last()).not.toHaveValue(label, { timeout: 30_000 });
    }).toPass({ timeout: 120_000 });
  });

  test("a joiner declares last year's employer income and the projection takes it", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("employee");
    await gotoRoute(page, "profile"); // one record page, two addresses: its `h1` is the person's name
    // Tax is a card on the Compensation tab: the declarations and the withholding they move are read together.
    await page.getByRole("tab", { name: "Compensation", exact: true }).click();

    const panel = page.getByRole("tabpanel");
    // Somebody who joined mid-year has already been taxed elsewhere this financial year, and the projection
    // is wrong until it knows - which is what this panel asks for.
    await expect(panel.getByText(/Joined mid-year\?/)).toBeVisible({ timeout: 30_000 });
    // Scoped to the mid-year block, and named either way: the button reads "Declare" on a first pass and
    // "Edit" once something is on file, so which one it is depends on what ran before this.
    // `.first()`: the filter matches the whole block AND the paragraph inside it, and only the block holds
    // the button.
    const midYear = panel.locator("div").filter({ hasText: /^Joined mid-year\?/ }).first();
    await midYear.getByRole("button", { name: /^(Declare|Edit)$/ }).first().click();

    const form = page.getByRole("dialog");
    await expect(form.getByText("Income from a previous employer (this financial year)")).toBeVisible();
    await form.getByLabel("Gross income").fill("450000");
    await form.getByLabel("TDS deducted").fill("32000");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The panel now says the projection counts it - the number is only useful because it changes the tax
    // shown right there.
    await expect(panel.getByText(/previous employer/).first()).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.getByRole("tab", { name: "Compensation", exact: true }).click();
    await expect(page.getByRole("tabpanel").getByText(/previous employer/).first()).toBeVisible({ timeout: 30_000 });

    // Declared, not verified: an employee's own figure does not lower withholding until payroll has seen the
    // proof, which is the whole point of the verification step.
    await expect(page.getByRole("tabpanel")).toContainText(/Declared|Pending|Unverified|verify/i);
  });
});

/**
 * Press one confirm dialog's own button, if it is up.
 *
 * Tolerant of its absence on purpose: the employee-fields panel asks before removing a SAVED field and again
 * when the server refuses to strand stored values, and a retry that re-enters the loop on a fresh snapshot
 * can legitimately meet neither. Scoped to the dialog because these labels repeat on the rows behind it.
 */
async function answer(page: import("@playwright/test").Page, label: string) {
  const button = page.getByRole("dialog").getByRole("button", { name: label, exact: true });
  const up = await button.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
  if (!up) return;
  await button.click();
  await expect(button).toHaveCount(0, { timeout: 30_000 });
}
