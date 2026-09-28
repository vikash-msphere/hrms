import { gotoRoute, purge, test, expect } from "./fixtures";

// The Pay Periods form (Settings → Payroll → Pay Periods) - every other payroll spec creates a period
// straight through the wire API to set up a run, so none of this form's own arithmetic has ever run: picking
// a start date prefills the month-end, the pay date and a label in one go (the overwhelming default is
// monthly), a period whose dates overlap a live one is flagged rather than silently double-paying those
// days, and a pay date that falls inside its own period gets its own note - the last days would be paid
// before they're worked.
test("picking a period start prefills month-end, flags an overlap, and end-before-start is refused", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  // Far enough out that no seeded or other spec's period plausibly shares this month.
  const label = `E2E period ${Date.now() % 100000}`;

  await gotoRoute(page, "payroll-runs/periods", "Pay Periods");
  await page.getByRole("button", { name: "New pay period" }).first().click();
  const form = page.getByRole("dialog");

  // One date in: the label, the period end and the pay date all follow from it.
  await form.getByLabel("Period start").fill("2031-03-15");
  await expect(form.getByLabel("Label")).toHaveValue(/March/);
  await expect(form.getByLabel("Label")).toHaveValue(/2031/);
  await expect(form.getByLabel("Period end")).toHaveValue("2031-03-31");
  await expect(form.getByLabel("Pay date")).toHaveValue("2031-03-31");
  // Paid on the day the period closes: no note about being paid early.
  await expect(form.getByText("The day the money reaches employees.")).toBeVisible();

  // Rename so the row is found by a name this spec controls, not the auto-filled month name.
  await form.getByLabel("Label").fill(label);

  const submit = form.getByRole("button", { name: "Create", exact: true });
  // An end before the start: refused on the field, and the submit follows it.
  await form.getByLabel("Period end").fill("2031-03-01");
  await expect(form.getByText("End is before the start.")).toBeVisible();
  await expect(submit).toBeDisabled();
  await form.getByLabel("Period end").fill("2031-03-31");
  await expect(submit).toBeEnabled();

  // A pay date inside the period: the last days would be paid before they're worked.
  await form.getByLabel("Pay date").fill("2031-03-20");
  await expect(form.getByText("Falls inside the period - the last days are paid before they're worked.")).toBeVisible();
  await form.getByLabel("Pay date").fill("2031-04-02");
  await expect(form.getByText("The day the money reaches employees.")).toBeVisible();

  await submit.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(label)).toBeVisible({ timeout: 30_000 });

  try {
    // A second period whose range overlaps the one just saved: flagged by name, before it's ever submitted.
    await page.getByRole("button", { name: "New pay period" }).first().click();
    const second = page.getByRole("dialog");
    await second.getByLabel("Period start").fill("2031-03-20");
    await expect(second.getByText(`Overlaps ${label}`, { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog");
    if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
      await discard.getByRole("button", { name: /Discard|Leave/ }).click();
    }
  } finally {
    const res = await page.request.get("/v1/pay-periods?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
      const created = results.find((p) => p.display_name === label);
      if (created) await purge(page, created.path);
    }
  }
});
