import { allowConsoleErrors, gotoRoute, test, expect, toast } from "./fixtures";

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
  // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.) - it can surface as a 503, or (this quick-run picks a month and
  // reuses whatever period/run already exists for it) as a 400 when a concurrent payroll spec's own build on
  // the SAME period lands in between two of this test's own requests. The retry this test already relies on
  // (Playwright's own, or the toPass blocks above) is what actually recovers from either.
  allowConsoleErrors(admin, /status of 503|status of 400|status of 409/i);
  await gotoRoute(admin, "payroll-runs", "Payroll");

  // The quick run: pick a month, get a pay period (created if the org has none for it) and a draft run. It
  // needs BOTH pay-periods.write and payroll-runs.write, which by design only a super admin holds - so this
  // is the one entry point that is not offered to the payroll role at all.
  await admin.getByRole("button", { name: "Quick monthly run" }).first().click();
  const quick = admin.getByRole("dialog");
  await expect(quick.getByRole("heading", { name: "Quick monthly run" })).toBeVisible();
  const period = (await quick.getByRole("combobox").first().innerText()).replace(" · period exists", "").trim();
  // The run's own wire path, taken from the create's OWN response rather than guessed from the table later:
  // several payroll specs run against this same month, so "the newest draft" is not this test's run, and the
  // build below needs to ask the SERVER about THIS run rather than trust a toast that lives five seconds.
  const [createdRun] = await Promise.all([
    admin.waitForResponse((r) => /\/v1\/payroll-runs$/.test(r.url()) && r.request().method() === "POST" && r.ok()),
    quick.getByRole("button", { name: "Create run" }).click(),
  ]);
  const runPath = ((await createdRun.json()) as { path: string }).path;
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
  // Retried: a transient 409/503 on a busy lane can leave the toast never arriving even though the press
  // landed - re-opening the menu and pressing again is safe, since a second Build on an already-built run is
  // the same request repeated, not a different one. Gated on the run's OWN COMPUTED LINES, asked of the
  // server, not on the toast: building leaves the run in DRAFT (only submitting moves it on), so the row says
  // nothing about it, and a toast lives about five seconds - a loaded machine misses it, and the loop then
  // waits forever on a notification for work that was already done.
  await expect(async () => {
    if (await built(admin, runPath)) return;
    const menuOpen = await admin.getByRole("menuitem", { name: "Build" }).count();
    if (menuOpen) {
      await admin.getByRole("menuitem", { name: "Build" }).click();
    } else {
      await row.getByRole("button", { name: "Actions" }).click();
      const build = admin.getByRole("menuitem", { name: "Build" });
      if (await build.count()) await build.click();
    }
    await expect
      .poll(() => built(admin, runPath), { timeout: 10_000 })
      .toBe(true);
  }).toPass({ timeout: 45_000 });

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
  // Either signal, not the toast alone: a transient 503 on a busy lane can leave it never arriving even
  // though the submit itself landed, and the row's own state outlasts the toast's few seconds on screen.
  await expect(async () => {
    const gotToast = await toast(admin, "Submitted for review").count();
    const inReview = await row.locator("text=/Review/i").count();
    expect(gotToast || inReview).toBeTruthy();
  }).toPass({ timeout: 30_000 });
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

  // Approved from the menu - retried, and REBUILDING between attempts, for the reason the server states:
  // `:approve` refuses a run whose income inputs moved since it was built ("rebuild it before approving"),
  // with no override, because approving a stale run pays the wrong money. A run in review is still editable,
  // so building again is exactly what the refusal asks for - and on this lane another spec editing the org's
  // pay catalogs, or anyone the run pays, is enough to move an input between the build above and this press.
  // Pressing Approve again on its own can only ask the same closed question.
  //
  // Gated on the row's own state, not on the toast: a toast lives about five seconds, and the row says
  // "Approved" for as long as the run is.
  const approved = async () => /approved/i.test(await row.innerText());
  await expect(async () => {
    if (await approved()) return;
    // Rebuild first: harmless on a fresh run (the same request repeated) and the whole point on a stale one.
    // "Rebuild" is the label the verb carries in this state - the review menu offers it precisely so the
    // refusal has a remedy on the menu that raised it.
    await row.getByRole("button", { name: "Actions" }).click();
    const rebuild = admin.getByRole("menuitem", { name: "Rebuild" });
    if (await rebuild.count()) await rebuild.click();
    else await admin.keyboard.press("Escape");
    // The page allows ONE transition in flight, so an Approve pressed while the rebuild is still going is
    // dropped on the floor. Waited for, not asserted: if the toast is missed the poll below simply fails this
    // attempt and the next one presses again.
    await toast(admin, /Run built/).waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

    await row.getByRole("button", { name: "Actions" }).click();
    const approve = admin.getByRole("menuitem", { name: "Approve" });
    if (await approve.count()) await approve.click();
    else await admin.keyboard.press("Escape");
    await expect.poll(approved, { timeout: 15_000 }).toBe(true);
  }).toPass({ timeout: 150_000 });

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

  // Take the run back out, so the lane can run again against the same month. The menu closed behind the
  // download above - picking any item dismisses it - so it is opened again for this one.
  await row.getByRole("button", { name: "Actions" }).click();
  await admin.getByRole("menuitem", { name: "Delete run" }).click();
  const confirm = admin.getByRole("dialog");
  await expect(confirm.getByText("Delete payroll run?")).toBeVisible();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(admin, "Run deleted")).toBeVisible();
});

/**
 * Whether the run has been BUILT - it has computed lines of its own.
 *
 * The run's `state` cannot answer this: a build leaves it in DRAFT (only submitting moves it to REVIEW), so
 * the table shows the same badge before and after. Its items are what a build actually produces, which is
 * also what the breakdown dialog reads, so this is the same fact the page shows - asked without a toast.
 */
async function built(page: import("@playwright/test").Page, runPath: string): Promise<boolean> {
  const res = await page.request.get(`/v1/${runPath}/items?page_size=1`);
  if (!res.ok()) return false;
  return (((await res.json()) as { results?: unknown[] }).results ?? []).length > 0;
}
