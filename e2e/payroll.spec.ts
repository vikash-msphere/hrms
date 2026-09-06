import { gotoRoute, test, expect, toast } from "./fixtures";

// Payroll, driven the way payroll is actually driven.
//
// This was the lane's biggest hole: nothing in `scripts/seed.sql` ships a run, and the whole state machine -
// draft, built, in review, approved - lives behind a kebab that offers exactly one step at a time. The
// arithmetic is `test/payroll.test.ts`'s business and is not re-checked here. What only a browser shows is
// the chain: that the quick-run dialog creates the period AND the run together, that each state offers its
// own next step and no other, that building opens the breakdown it has just computed, and that the approval
// is withheld from the person who ran it.
//
// It stops at Publish. Publishing notifies every employee, generates payslips, and cannot be undone or
// deleted - so the spec asserts the affordance is THERE on an approved run (which is the proof the machine
// arrived) and then deletes the run, so the next run of the lane starts where this one did.
test("a payroll run is created, built, submitted and approved - and payroll cannot approve it", async ({ as }) => {
  test.setTimeout(120_000);
  const admin = await as("super");
  await gotoRoute(admin, "payroll-runs", "Payroll");

  // The quick run: pick a month, get a pay period (created if the org has none for it) and a draft run. It
  // needs BOTH pay-periods.write and payroll-runs.write, which by design only a super admin holds - so this
  // is the one entry point that is not offered to the payroll role at all.
  await admin.getByRole("button", { name: "Quick monthly run" }).first().click();
  const quick = admin.getByRole("dialog");
  await expect(quick.getByRole("heading", { name: "Quick monthly run" })).toBeVisible();
  const period = (await quick.getByRole("combobox").first().innerText()).replace(" · period exists", "").trim();
  await quick.getByRole("button", { name: "Create run" }).click();
  await expect(toast(admin, /Monthly run created|Payroll run created/)).toBeVisible();

  const row = admin.locator("tbody tr").filter({ hasText: period }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Draft/i);

  // Draft offers Build and Submit - and NOT approve or publish, which is the half of the state machine a
  // reader has to be able to trust.
  await row.getByRole("button", { name: "Actions" }).click();
  await expect(admin.getByRole("menuitem", { name: "Build" })).toBeVisible();
  await expect(admin.getByRole("menuitem", { name: "Publish" })).toHaveCount(0);
  await expect(admin.getByRole("menuitem", { name: "Approve" })).toHaveCount(0);
  await admin.getByRole("menuitem", { name: "Build" }).click();
  await expect(toast(admin, /Run built/)).toBeVisible();

  // The numbers it computed are readable from the same menu - a run nobody can look inside is a number
  // nobody can defend.
  await row.getByRole("button", { name: "Actions" }).click();
  await admin.getByRole("menuitem", { name: "Review" }).click();
  const breakdown = admin.getByRole("dialog").filter({ hasText: /Payroll breakdown/ });
  await expect(breakdown.getByRole("heading", { name: /Payroll breakdown/ })).toBeVisible();

  // A payslip preview, rendered from this run's own computed lines before anything is published - the run's
  // numbers, not the last real payslip this person happened to have.
  await breakdown.locator("tbody tr").first().getByRole("button", { name: "Preview this payslip" }).click();
  const slip = admin.getByRole("dialog").filter({ hasText: "Payslip preview" });
  const slipFrame = slip.getByTitle(/Payslip preview/);
  await expect(slipFrame).toBeVisible({ timeout: 30_000 });
  await expect(slipFrame).toHaveAttribute("src", /^blob:/);
  await expect(slip.getByText("draft, not yet issued", { exact: false })).toBeVisible();
  await admin.keyboard.press("Escape");
  await expect(slip).toHaveCount(0, { timeout: 15_000 });

  // Closed with a loop rather than one press: the breakdown can raise the split-drift prompt over itself
  // ("re-apply the split to existing employees?") when a pay component has changed since the build, which is
  // a second dialog to answer - and another spec editing the component catalog is enough to trigger it.
  await expect(async () => {
    const open = admin.getByRole("dialog");
    if (!(await open.count())) return;
    const later = open.getByRole("button", { name: /Later|Cancel|No/ });
    if (await later.count()) await later.first().click();
    else await admin.keyboard.press("Escape");
    await expect(admin.getByRole("dialog")).toHaveCount(0);
  }).toPass({ timeout: 30_000 });

  await row.getByRole("button", { name: "Actions" }).click();
  await admin.getByRole("menuitem", { name: "Submit" }).click();
  await expect(toast(admin, "Submitted for review")).toBeVisible();
  await expect(row).toContainText(/Review/i);

  // A run in review is exactly where the second pair of eyes belongs - and the payroll role, who runs
  // payroll, is not that pair. They can see the run and its numbers; the approval is not on their menu.
  const payroll = await as("payroll");
  await gotoRoute(payroll, "payroll-runs", "Payroll");
  const theirRow = payroll.locator("tbody tr").filter({ hasText: period }).first();
  await expect(theirRow).toContainText(/Review/i);
  await theirRow.getByRole("button", { name: "Actions" }).click();
  await expect(payroll.getByRole("menuitem", { name: "Review" })).toBeVisible();
  await expect(payroll.getByRole("menuitem", { name: "Approve" })).toHaveCount(0);
  await payroll.keyboard.press("Escape");

  await row.getByRole("button", { name: "Actions" }).click();
  await admin.getByRole("menuitem", { name: "Approve" }).click();
  await expect(toast(admin, /Run approved/)).toBeVisible();
  await expect(row).toContainText(/Approved/i);

  // Approved: publishing is now on the menu, and so is the statutory report the run's numbers feed.
  await row.getByRole("button", { name: "Actions" }).click();
  await expect(admin.getByRole("menuitem", { name: "Publish" })).toBeVisible();
  await expect(admin.getByRole("menuitem", { name: /Statutory report/ })).toBeVisible();

  // The report itself, not just its presence on the menu: a real workbook built from this run's own numbers,
  // never clicked by anything else in the lane.
  const [report] = await Promise.all([
    admin.waitForEvent("download"),
    admin.getByRole("menuitem", { name: "Statutory report (.xlsx)" }).click(),
  ]);
  expect(report.suggestedFilename()).toMatch(/\.xlsx$/);
  const reportPath = await report.path();
  if (!reportPath) throw new Error("the statutory report produced no file");
  const { readFile } = await import("node:fs/promises");
  const reportBytes = await readFile(reportPath);
  expect(reportBytes.subarray(0, 2).toString("latin1")).toBe("PK"); // xlsx is a zip
  expect(reportBytes.length).toBeGreaterThan(1000);

  // The PF ECR file: same verb, a different `format` param, and a plain-text file rather than a workbook -
  // the statutory filing format, not a human-readable report.
  await row.getByRole("button", { name: "Actions" }).click();
  const [ecr] = await Promise.all([
    admin.waitForEvent("download"),
    admin.getByRole("menuitem", { name: "PF ECR file (.txt)" }).click(),
  ]);
  expect(ecr.suggestedFilename()).toMatch(/\.txt$/);
  const ecrPath = await ecr.path();
  if (!ecrPath) throw new Error("the PF ECR file produced no file");
  const ecrBytes = await readFile(ecrPath);
  expect(ecrBytes.length).toBeGreaterThan(0);

  // Take the run back out, so the lane can run again against the same month.
  await admin.getByRole("menuitem", { name: "Delete run" }).click();
  const confirm = admin.getByRole("dialog");
  await expect(confirm.getByText("Delete payroll run?")).toBeVisible();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(admin, "Run deleted")).toBeVisible();
});
