import { gotoRoute, purge, test, expect } from "./fixtures";

// The leave-type form's own summary line - `catalogEditors.spec.ts` only ever saves a bare name, so none of
// the four policy panels (accrual, probation, encashment, carry-forward) or the sentence the form says back
// before saving have ever run. Four bordered panels of switches are each clear alone and easy to misread
// together, so what matters is that the summary - and the fields a panel disables when its own switch is
// off - track every toggle live, not just at the moment of save.
test("the leave-type summary and disabled fields track every policy toggle live", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const name = `E2E leave type ${Date.now()}`;

  await gotoRoute(page, "settings/leave-types");
  await page.getByRole("button", { name: "New leave type" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name", { exact: true }).fill(name);
  // The whole sentence is the paragraph; the name is a <span> INSIDE it, and that span is what a text lookup
  // for "<name>:" resolves to - a container that never contains any of the policy words.
  const summary = form.locator("p").filter({ hasText: `${name}:` });

  // Monthly accrual: half a day short of a day, credited whole on the 1st.
  await form.getByLabel("Accrual days per year").fill("24");
  await expect(summary).toContainText("24 days a year, credited 2 on the 1st of each month");

  // The same 24 days, split across two credit dates instead.
  await form.getByLabel("Accrual frequency").click();
  await page.getByRole("option", { name: "Twice a month (1st & 16th)" }).click();
  await expect(summary).toContainText("credited 1 on the 1st and the 16th");

  // Unpaid: the summary says so, in place of "paid".
  await form.locator("#paid").click();
  await expect(summary).toContainText("unpaid");

  // Everything from here down - probation, encashment, carry-forward - moved to the BALANCE tab when the
  // dialog was split into Basics / Balance / Restrictions. A tab renders only its own panel, so those fields
  // are not in the DOM at all until it is selected; without this the first of them reads as a field that
  // vanished. The summary itself sits below the tabs and describes the whole form, so it stays put.
  // Scoped to the dialog's own tablist: "Balance" is a short word, and the page behind carries tabs too.
  await form.getByRole("tablist", { name: "Leave type sections" }).getByRole("tab", { name: "Balance", exact: true }).click();

  // Off probation: the panel's own fields go inert, and the summary drops the accrual clause for a flat refusal.
  const probationCap = form.getByLabel("Probation cap (days)");
  await expect(probationCap).toBeEnabled();
  await form.locator("#probation").click();
  await expect(probationCap).toBeDisabled();
  await expect(summary).toContainText("cannot be requested on probation");

  // Back on probation, with its own accrual and cap.
  await form.locator("#probation").click();
  await expect(probationCap).toBeEnabled();
  await form.getByLabel("Probation accrual / year").fill("5");
  await form.getByLabel("Probation cap (days)").fill("10");
  await expect(summary).toContainText("on probation: 5 days a year, at most 10 takeable");

  // Not encashable by default: the cap and retained-minimum fields are inert until it is switched on.
  const encashCap = form.getByLabel("Annual cap (days)");
  await expect(encashCap).toBeDisabled();
  await expect(summary).toContainText("not encashable");
  await form.locator("#encashable").click();
  await expect(encashCap).toBeEnabled();
  await encashCap.fill("15");
  await form.getByLabel("Minimum balance retained").fill("3");
  await expect(summary).toContainText("encashable up to 15 days a year, keeping 3 days in the balance");

  // Resets by default; carrying forward names its own cap once it's on.
  await expect(summary).toContainText("unused balance resets on 31 Dec");
  await form.locator("#carryForward").click();
  await form.getByLabel("Carry-forward cap (days)").fill("5");
  await expect(summary).toContainText("carries into the next year (up to 5 days)");

  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    // The row behind the dialog repeats the same policy, in the caps it actually saved.
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Encashable (≤15/yr)");
    await expect(row).toContainText("Carry-forward (≤5)");
  } finally {
    const res = await page.request.get("/v1/leave-types?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
      const created = results.find((t) => t.display_name === name);
      if (created) await purge(page, created.path);
    }
  }
});
