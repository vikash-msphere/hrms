import { gotoRoute, test, expect, toast } from "./fixtures";

// A salary loan, from asking to money-out.
//
// `test/loanRepayment.test.ts` owns the EMI arithmetic and the recovery that rides payroll. The browser half
// is the one nobody else can see: the borrower's form previews what will be taken each month BEFORE they
// commit (the number people actually decide on), and payroll then walks the same record through approve,
// disburse and a manual repayment - three different affordances that appear one at a time, on a card that
// has to re-render into each state.
test("an employee asks for a loan and payroll approves, disburses and records a repayment", async ({ as }) => {
  const borrower = await as("employee");
  const payroll = await as("payroll");

  const reason = `E2E loan ${Date.now()}`;
  await gotoRoute(borrower, "loans", "Loans & Advances");
  await borrower.getByRole("button", { name: "Request loan" }).first().click();
  const form = borrower.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Request a loan or advance" })).toBeVisible();

  await form.getByLabel("Amount").fill("60000");
  // The repayment chips are what a borrower actually reaches for, and picking one has to move the preview.
  await form.getByRole("button", { name: "6 months" }).click();
  await expect(form.getByText("Deducted each month")).toBeVisible();
  await expect(form.getByText("Installments")).toBeVisible();
  await form.getByLabel(/Reason/).fill(reason);
  await form.getByRole("button", { name: "Request", exact: true }).click();

  // The list is the receipt here - a request raises no toast of its own, it simply appears, pending.
  await expect(borrower.getByRole("dialog")).toHaveCount(0);
  const theirCard = borrower.locator("div.shadow-card").filter({ hasText: reason }).first();
  await expect(theirCard).toContainText(/Pending/i);

  // Payroll's turn. The card carries exactly the action its state allows, and nothing else.
  await gotoRoute(payroll, "loans", "Loans & Advances");
  const card = payroll.locator("div.shadow-card").filter({ hasText: reason }).first();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Mark disbursed" })).toHaveCount(0);

  await card.getByRole("button", { name: "Approve" }).click();
  await expect(toast(payroll, "Request approved")).toBeVisible();

  // Disbursal is money leaving, so it asks first and says what it will start.
  await card.getByRole("button", { name: "Mark disbursed" }).click();
  const confirm = payroll.getByRole("dialog");
  await expect(confirm.getByText("Mark this loan as disbursed?")).toBeVisible();
  await confirm.getByRole("button", { name: "Mark disbursed" }).click();
  await expect(toast(payroll, /Marked disbursed/)).toBeVisible();

  // Now disbursed, the card grows the outstanding balance and the repayment affordance.
  await expect(card).toContainText("Outstanding");
  await card.getByRole("button", { name: "Record repayment" }).click();
  const repay = payroll.getByRole("dialog");
  await expect(repay.getByRole("heading", { name: "Record repayment" })).toBeVisible();
  await repay.getByLabel("Amount").fill("10000");
  await repay.getByRole("button", { name: "Record repayment", exact: true }).click();
  await expect(toast(payroll, "Repayment recorded")).toBeVisible();

  // The borrower sees what they still owe, on their own page.
  await borrower.reload();
  await expect(borrower.getByRole("main")).toBeVisible();
  await expect(borrower.locator("div.shadow-card").filter({ hasText: reason }).first()).toContainText("Outstanding");
});
