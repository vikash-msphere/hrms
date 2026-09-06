import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// Declaring a tax-saving investment, and payroll verifying it - the whole page has never been opened by any
// spec (only the generic route/tab sweeps). Payroll, not HR: hr_admin holds only READ on tax-declarations
// (scripts/seed.sql) - verifying and rejecting are payroll_admin's alone, since it's their withholding this
// changes. Two things only a browser shows: the statutory cap warning (80C caps at a fixed figure a year -
// advisory, not blocking, since the excess simply never reduces tax rather than being refused), and the
// verify dialog's own math - a partial verified amount is flagged against what was actually declared, and
// only the verified figure is what locks in.
test("an 80C declaration is filed under its cap, then partially verified by payroll", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const payroll = await as("payroll");
  const label = `E2E declaration ${Date.now()}`;

  await gotoRoute(employee, "tax-declarations", "Tax Declarations");
  await employee.getByRole("button", { name: "Add declaration" }).first().click();
  const form = employee.getByRole("dialog");
  await expect(form.getByRole("heading", { name: /Declare for FY/ })).toBeVisible();

  // 80C is selected by default: the cap is named before anything else is typed.
  await expect(form.getByText("80C caps at", { exact: false })).toBeVisible();
  await form.getByLabel("Amount").fill("100000");
  await form.getByLabel("What is it? (optional)").fill(label);
  await form.getByRole("button", { name: "Declare", exact: true }).click();
  await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(employee.getByText(label)).toBeVisible({ timeout: 30_000 });

  let declPath: string | undefined;
  try {
    // Not a moment sooner: the row this spec just filed has to exist before payroll can find it.
    const listed = await payroll.request.get("/v1/tax-declarations?page_size=200");
    const { results = [] } = (await listed.json()) as { results?: { path: string; label?: string }[] };
    declPath = results.find((d) => d.label === label)?.path;
    expect(declPath, "the declaration is not in the collection").toBeTruthy();

    await gotoRoute(payroll, "tax-declarations", "Tax Declarations");
    const row = payroll.locator("tbody tr").filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Verify", exact: true }).click();
    const verify = payroll.getByRole("dialog").filter({ hasText: "Verify declaration" });
    await expect(verify).toBeVisible();
    await expect(verify.getByText("Nothing attached")).toBeVisible();
    await expect(verify.getByText("No proof is attached.", { exact: false })).toBeVisible();

    // Half the claim: flagged against the full declared amount, not silently accepted.
    await verify.getByLabel("Verified amount").fill("50000");
    await expect(verify.getByText("50,000 less than declared", { exact: false })).toBeVisible();

    // The one-press "accept in full" - the hint clears once the figure actually matches the claim.
    await verify.getByRole("button", { name: /Accept the full/ }).click();
    await expect(verify.getByLabel("Verified amount")).toHaveValue("100000");
    await expect(verify.getByText("less than declared", { exact: false })).toHaveCount(0);

    await verify.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(toast(payroll, "Declaration verified")).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/Verified/i, { timeout: 30_000 });

    // Locked: the employee's own row no longer offers Edit or Delete once it's verified.
    await employee.reload();
    await expect(employee.getByRole("main")).toBeVisible();
    const mineRow = employee.locator("tbody tr").filter({ hasText: label });
    await expect(mineRow).toContainText(/Verified/i, { timeout: 30_000 });
    await expect(mineRow.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(mineRow.getByRole("button", { name: "Delete" })).toHaveCount(0);
  } finally {
    if (declPath) await purge(payroll, declPath);
  }
});
