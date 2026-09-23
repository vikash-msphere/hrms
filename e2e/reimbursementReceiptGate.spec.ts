import { gotoRoute, purge, test, expect, toast, ymd } from "./fixtures";

// The receipt-required gate and the duplicate-claim advisory - `reimbursements.spec.ts` deliberately claims
// against "Meals" (the seeded category that needs no receipt) to drive the plain happy path, so neither of
// these ever runs: "Travel" is seeded to require one, and the form has to say so, refuse to submit without
// one, and say so differently once a file is actually attached - and filing the exact same amount, category
// and date twice is the classic claim mistake, worth flagging before it's sent rather than after.
test("a receipt-required category blocks submit until a file is attached, and a repeat claim is flagged", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("employee");
  const today = ymd();
  const amount = 3000 + Math.floor(Math.random() * 900);
  const stamp = `E2E travel claim ${Date.now()}`;

  await gotoRoute(page, "reimbursements", "Reimbursements");
  await page.getByRole("button", { name: "New claim" }).first().click();
  let form = page.getByRole("dialog");

  await form.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /Travel/ }).click();

  // Required, not optional - said before anything is attached.
  await expect(form.getByText("This category requires a receipt - attach one to submit.")).toBeVisible();
  await expect(form.getByText("Receipt", { exact: true })).toBeVisible();
  await expect(form.getByText("Receipt (optional)")).toHaveCount(0);

  await form.getByLabel("Amount").fill(String(amount));
  await form.getByLabel("Date incurred").fill(today);
  await form.getByLabel(/Description/).fill(stamp);
  const submit = form.getByRole("button", { name: "Submit claim" });
  await expect(submit).toBeDisabled();

  await form.locator('input[type="file"]').setInputFiles({
    name: "e2e-receipt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF", "latin1"),
  });
  await expect(form.getByText("Attached: e2e-receipt.pdf")).toBeVisible();
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(toast(page, "Claim submitted")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    // The exact same claim again: category, amount and date all match the one just filed - flagged, not
    // silently allowed to look like it never went through the first time.
    await page.getByRole("button", { name: "New claim" }).first().click();
    form = page.getByRole("dialog");
    await form.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /Travel/ }).click();
    await form.getByLabel("Amount").fill(String(amount));
    await form.getByLabel("Date incurred").fill(today);

    await expect(form.getByText(/You already have a claim for/)).toBeVisible();
    await expect(form.getByText(/still pending/)).toBeVisible();
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog");
    if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
      await discard.getByRole("button", { name: /Discard|Leave/ }).click();
    }
  } finally {
    // Purging a submitted claim outright needs the `admin` verb, which an employee is never granted on their
    // own reimbursements (only cancel/upload/download) - a separate super session takes it off the shelf.
    const cleanup = await as("super");
    const res = await cleanup.request.get("/v1/reimbursements?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; description?: string }[] };
      const claim = results.find((r) => r.description === stamp);
      if (claim) await purge(cleanup, claim.path);
    }
  }
});
