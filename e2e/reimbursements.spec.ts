import { gotoRoute, test, expect, toast, ymd } from "./fixtures";

// Claiming money back, and being told yes.
//
// The claim is the app's most ordinary two-person flow: an employee files it against a category, the desk
// that decides claims finds it in a queue, and the employee's own page has to change. The reimbursement
// service tests own the amounts and the state machine. What only a browser shows is the round trip across
// two people's screens - the form that composes the claim (a category the org configured, an amount, and a
// date it refuses to accept in the future), the queue it lands in, and the employee's list agreeing
// afterwards, in the right tab, without anybody being told where to look.
//
// The decider is HR, not the requester's manager: the seeded policy hands `reimbursements.*.approve` to HR
// and deliberately keeps managers out of it (src/domain/grants.ts). A spec that used the manager would be
// testing a grant the org does not have.
test("an employee claims an expense back and the claims desk approves it", async ({ as }) => {
  const employee = await as("employee");
  const approver = await as("hr");

  await gotoRoute(approver, "approvals", "Approvals");
  await approver.waitForLoadState("networkidle").catch(() => {});

  // A distinctive amount is how this run's claim is found again: the description column is hidden by
  // default, so the money is the only text on the row that this spec controls. The currency mark is part of
  // the pattern too, not just the digits - `formatMoney`/`lib/intl.ts` is what puts it there, and a
  // regression that dropped the symbol (or the grouping comma an amount this size needs) would still leave
  // plain digits on the row for a looser pattern to match.
  const rupees = 4000 + Math.floor(Math.random() * 900);
  const onRow = new RegExp(`₹${String(rupees).slice(0, 1)},?${String(rupees).slice(1)}`);

  // "Meals" is the seeded category that needs no receipt, so this drives the form rather than the upload
  // path (which `documentUpload` owns).
  await gotoRoute(employee, "reimbursements", "Reimbursements");
  await employee.getByRole("button", { name: "New claim" }).first().click();
  const form = employee.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "New reimbursement claim" })).toBeVisible();

  await form.getByRole("combobox").first().click();
  await employee.getByRole("option", { name: /Meals/ }).click();
  await form.getByLabel("Amount").fill(String(rupees));
  await form.getByLabel(/Description/).fill(`E2E claim ${Date.now()}`);

  // The one validation a person actually hits, and it blocks the submit rather than being swallowed on send.
  const submit = form.getByRole("button", { name: "Submit claim" });
  await form.getByLabel("Date incurred").fill("2099-01-01");
  // Field errors arm on BLUR, not on the first keystroke - a field that reddens while it is being typed into
  // is telling the reader off for not having finished. So leave the field, the way a person would.
  await form.getByLabel("Date incurred").blur();
  await expect(form.getByText(/That's in the future/)).toBeVisible();
  await expect(submit).toBeDisabled();
  await form.getByLabel("Date incurred").fill(today());
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(toast(employee, "Claim submitted")).toBeVisible();

  // Their own live requests, in the tab that holds what is still waiting on somebody.
  await employee.getByRole("tab", { name: /^Requests/ }).click();
  const mine = employee.locator("tbody tr").filter({ hasText: onRow });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(/Pending/i);

  // The decider's queue grew by exactly this one. A reload rather than a navigation: one person's write
  // cannot invalidate a cache in somebody else's browser.
  await approver.reload();
  await expect(approver.getByRole("main")).toBeVisible();
  // And the decision, on THIS claim - the queue holds other people's requests too, and the confirmation
  // names whose request it is precisely so the wrong row cannot be decided by accident.
  const claimRow = approver
    .locator("div")
    .filter({ hasText: onRow })
    .filter({ has: approver.getByRole("button", { name: "Approve", exact: true }) })
    .last();
  await claimRow.getByRole("button", { name: "Approve", exact: true }).click();
  const confirm = approver.getByRole("dialog");
  await expect(confirm.getByText("Approve this request?")).toBeVisible();
  await expect(confirm).toContainText(/Eve Employee/);
  await confirm.getByRole("button", { name: "Approve", exact: true }).click();
  // The settle, not the toast: THIS claim leaves the queue by itself, which is the assertion that matters
  // (and the one that neither races a five-second toast nor counts a queue other specs are also using).
  await expect(
    approver.locator("div").filter({ hasText: onRow }).filter({ has: approver.getByRole("button", { name: "Approve", exact: true }) }),
  ).toHaveCount(0, { timeout: 30_000 });

  // The employee looks again: the claim has left their live requests for their history, decided. Either word,
  // not just "Approved": a payroll run's own cron sweep can pay an approved reimbursement out before this
  // check ever runs (this suite's own payroll specs build and pay runs constantly under 16-worker load), and
  // "Paid" is Approved having moved one step further, not a wrong state this test caused.
  await employee.reload();
  await expect(employee.getByRole("main")).toBeVisible();
  await employee.getByRole("tab", { name: /^History/ }).click();
  await expect(employee.locator("tbody tr").filter({ hasText: onRow })).toContainText(/Approved|Paid/i);
});

/** Today, as a date input wants it. */
function today(): string {
  return ymd();
}
