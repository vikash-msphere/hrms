import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// A salary advance, from asked-for to paid back.
//
// `loans.spec.ts` covers an employee asking. This is the desk's side, which is four distinct decisions with
// four distinct meanings: approving a loan is not lending it, disbursing is the moment money leaves, and a
// repayment recorded by hand is the one that did NOT come out of payroll (a transfer, a cash return, a
// correction). `test/loans.test.ts` owns the EMI arithmetic and the payroll recovery. What only a browser
// shows is that each state offers exactly the next step and no other - a loan cannot be disbursed before it
// is approved, and cannot take a repayment before it is disbursed.
test("a loan is approved, disbursed, and takes a repayment - one step at a time", async ({ as }) => {
  test.setTimeout(180_000);
  const employee = await as("employee");
  const reason = `E2E loan ${Date.now()}`;
  // Payroll, not HR: the seeded policy gives HR visibility of loans and gives PAYROLL the decisions
  // (approve / reject / disburse / recordRepayment), because those are money movements.
  const desk = await as("payroll");

  // Asked for over the wire: the request form is `loans.spec.ts`'s subject.
  const made = await employee.request.post("/v1/loans", {
    headers: SPA_HEADERS,
    data: { principal: 60000, installments: 6, reason },
  });
  expect(made.status(), await made.text()).toBe(200);
  const loan = (await made.json()) as { path: string };
  const id = loan.path.split("/")[1]!;

  await gotoRoute(desk, "loans", "Loans & Advances");
  // The page draws loans as CARDS, not table rows: a loan is a small ledger (principal, EMI, what is left),
  // which does not read as a row of cells.
  const card = desk.locator("div").filter({ hasText: reason }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });

  // Pending offers approve or reject, and nothing else: money that has not been agreed cannot be paid.
  await expect(card.getByRole("button", { name: "Mark disbursed" })).toHaveCount(0);
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card.getByText(/Approved/i).first()).toBeVisible({ timeout: 30_000 });

  // Approved offers disbursal - the step where the money actually moves, so it is its own decision rather
  // than a side effect of approving.
  await card.getByRole("button", { name: "Mark disbursed" }).click();
  // Money leaving is a decision the app asks about, and the confirm repeats the words of the button rather
  // than a generic yes.
  const confirm = desk.getByRole("dialog");
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await confirm.getByRole("button", { name: "Mark disbursed" }).click();
  await expect(desk.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(card.getByText(/Disbursed/i).first()).toBeVisible({ timeout: 30_000 });

  // And only now can a repayment be recorded: one made outside payroll, which is the case the EMI schedule
  // cannot know about.
  await card.getByRole("button", { name: "Record repayment" }).click();
  const repay = desk.getByRole("dialog");
  await expect(repay.getByRole("heading", { name: "Record repayment" })).toBeVisible();
  await repay.getByRole("textbox").first().fill("10000");
  await repay.getByRole("button", { name: /^(Record|Save)/ }).last().click();
  await expect(desk.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The ledger moved, which is what a repayment IS - asserted on the record rather than on a toast.
  const after = await desk.request.get(`/v1/loans/${id}`);
  expect(after.ok(), await after.text()).toBe(true);
  const state = (await after.json()) as { status?: string; outstanding?: number };
  expect(state.status).toBe("DISBURSED");
  expect(state.outstanding, "the repayment came off what is owed").toBeLessThan(60000);

  await purge(desk, loan.path);
});
