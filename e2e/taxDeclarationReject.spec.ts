import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// The other decision on a filed declaration - `taxDeclarationVerify.spec.ts` walks the verify path (partial
// amounts, the accept-in-full shortcut, the record locking afterwards) but never presses Reject, payroll's
// other option for a declaration with a problem (a receipt that doesn't match, an ineligible instrument).
// Unlike verify, reject does NOT lock the record: the confirm copy says the employee can edit and resubmit,
// which this proves rather than assumes.
test("payroll rejects a declared investment, and the employee can edit it again", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const payroll = await as("payroll");
  const label = `E2E reject declaration ${Date.now()}`;

  await gotoRoute(employee, "tax-declarations", "Tax Declarations");
  await employee.getByRole("button", { name: "Add declaration" }).first().click();
  const form = employee.getByRole("dialog");
  await form.getByLabel("Amount").fill("20000");
  await form.getByLabel("What is it? (optional)").fill(label);
  await form.getByRole("button", { name: "Declare", exact: true }).click();
  await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(employee.getByText(label)).toBeVisible({ timeout: 30_000 });

  let declPath: string | undefined;
  try {
    const listed = await payroll.request.get("/v1/tax-declarations?page_size=200");
    const { results = [] } = (await listed.json()) as { results?: { path: string; label?: string }[] };
    declPath = results.find((d) => d.label === label)?.path;
    expect(declPath, "the declaration is not in the collection").toBeTruthy();

    await gotoRoute(payroll, "tax-declarations", "Tax Declarations");
    const row = payroll.locator("tbody tr").filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Reject" }).click();
    const confirm = payroll.getByRole("dialog");
    await expect(confirm.getByText(/Reject the .* declaration\?/)).toBeVisible();
    await expect(confirm.getByText(/can edit it to fix the problem/)).toBeVisible();
    await confirm.getByRole("textbox", { name: "Reason", exact: true }).fill(WHY);
    await confirm.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(toast(payroll, "Declaration rejected")).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/Rejected/i, { timeout: 30_000 });

    // Not locked: unlike a verified one, the employee's own row still offers Edit on a rejected declaration,
    // and says why it was rejected.
    await employee.reload();
    await expect(employee.getByRole("main")).toBeVisible();
    const mineRow = employee.locator("tbody tr").filter({ hasText: label });
    await expect(mineRow).toContainText(/Rejected/i, { timeout: 30_000 });
    await expect(mineRow).toContainText(WHY);
    await expect(mineRow.getByRole("button", { name: "Edit" })).toBeVisible({ timeout: 30_000 });
  } finally {
    if (declPath) await purge(payroll, declPath);
  }
});

const WHY = "The receipt is for a different policy";
