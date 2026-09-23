import { gotoRoute, test, expect } from "./fixtures";

// An amount arrives dressed - "1,20,000" out of a bank statement, a stray non-breaking space out of an email
// - and `type="number"` rejects all of it silently, leaving an empty field with no clue why. `MoneyInput`
// takes text instead and undresses the value itself (`sanitize` in the component), then echoes back what it
// understood: the grouped, currency-symbol figure AND - past a lakh, where the raw digit count is what people
// actually misread - the short form ("1.2L"). None of that arithmetic is new (`formatMoney`/`lib/intl.ts`
// render it the same way everywhere), so what is only true in a browser is that PASTING/typing the dressed
// string actually lands as the clean number the form submits, and that the reader sees the same figure back
// immediately, before anything is sent anywhere.
test("a messy pasted amount is undressed to a plain number, with the currency reading it back live", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("employee");

  await gotoRoute(page, "loans", "Loans & Advances");
  await page.getByRole("button", { name: "Request loan" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Request a loan or advance" })).toBeVisible();

  const amount = form.getByLabel("Amount");
  // Exactly what a bank statement or a spreadsheet cell hands someone: grouping commas in the en-IN place,
  // which `sanitize` has to strip without mistaking a comma for a decimal point.
  await amount.fill("₹1,20,000");
  await expect(amount).toHaveValue("120000");

  // The readback: the currency's own formatting of that same number, live, and the compact short form a
  // lakh earns. Not asserted as one exact string - the org's configured decimal precision is a setting this
  // spec doesn't own - but both pieces have to be there.
  const readback = form.locator("#money-readback, [id$='-readback']").first();
  await expect(readback).toContainText("₹120,000");
  await expect(readback).toContainText("1.2L");

  // A second dot, a letter, a stray space - none of it survives, and the one dot that matters isn't dropped
  // for having something before it.
  await amount.fill("1 2a0.5.6 kg");
  await expect(amount).toHaveValue("120.56");

  await page.keyboard.press("Escape");
  const discard = page.getByRole("button", { name: /Discard|Leave/ });
  if (await discard.count()) await discard.first().click();
});
