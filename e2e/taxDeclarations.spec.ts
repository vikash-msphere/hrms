import { gotoRoute, test, expect, toast } from "./fixtures";

// A tax-saving declaration, and the verification that makes it count.
//
// The rule the whole feature turns on is that a declaration changes nothing until payroll verifies it, and
// only the VERIFIED figure cuts withholding (`test/taxProjection.test.ts` owns that arithmetic). The browser
// half is how that rule is communicated and driven: the employee's form warns when a section's annual cap is
// already used up - the mistake people actually make - and payroll's verify dialog lets them bank a
// different number from the one claimed, which is the whole point of verifying.
test("an employee declares under a section and payroll verifies a different amount", async ({ as }) => {
  const employee = await as("employee");
  const payroll = await as("payroll");

  const label = `E2E declaration ${Date.now()}`;
  await gotoRoute(employee, "tax-declarations", "Tax Declarations");
  await employee.getByRole("button", { name: "Add declaration" }).first().click();
  const form = employee.getByRole("dialog");
  await expect(form.getByRole("heading", { name: /Declare for FY/ })).toBeVisible();

  // The cap line is the form's real work: it says how much room is left under the section before anything is
  // typed, and it warns once the claim goes past it.
  await expect(form.getByText(/caps at/)).toBeVisible();
  await form.getByLabel("Amount").fill("900000");
  await expect(form.getByText(/won't reduce your tax/)).toBeVisible();

  await form.getByLabel(/What is it/).fill(label);
  await form.getByLabel("Amount").fill("50000");
  await form.getByRole("button", { name: "Declare", exact: true }).click();
  await expect(toast(employee, "Declared")).toBeVisible();
  await expect(employee.getByText(label)).toBeVisible();

  // Payroll verifies a LOWER figure than claimed - proof only covered part of it, which is the case the
  // dialog exists for.
  await gotoRoute(payroll, "tax-declarations", "Tax Declarations");
  const claim = payroll.locator("div.shadow-card, tbody tr, li").filter({ hasText: label }).last();
  await expect(claim).toBeVisible();
  await claim.getByRole("button", { name: "Verify" }).click();
  const verify = payroll.getByRole("dialog");
  await expect(verify.getByRole("heading", { name: "Verify declaration" })).toBeVisible();
  await verify.getByLabel("Amount").fill("30000");
  await verify.getByRole("button", { name: /Verify/ }).last().click();
  await expect(toast(payroll, "Declaration verified")).toBeVisible();

  // The employee is told what was actually banked, not what they asked for.
  await employee.reload();
  await expect(employee.getByRole("main")).toBeVisible();
  await expect(employee.getByText(label)).toBeVisible();
  await expect(employee.getByText(/Verified/i).first()).toBeVisible();
});
