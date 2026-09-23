import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Three row actions on Expenses that `expenses.spec.ts` never reaches, because that spec deliberately walks
// the OTHER path (approve → pay) start to finish: rejecting a submitted expense with a canned reason,
// cancelling one outright, and attaching/viewing/downloading its invoice from the row menu (not the create
// form). All three are real, separately-gated verbs (`reject`, `cancel`, the `upload`/`download` attachment
// slot) with their own dialogs and their own read-back - not just alternate labels on the same button.
test("a submitted expense is rejected with a canned reason, a draft is cancelled, and an invoice is attached and read back", async ({ as }) => {
  test.setTimeout(150_000);
  const page = await as("super");
  const category = await officeSupplies(page);
  const stamp = Date.now();

  const rejected = await createExpense(page, category, `E2E reject ${stamp}`, 1200, true);
  const cancelled = await createExpense(page, category, `E2E cancel ${stamp}`, 800, false);
  const invoiced = await createExpense(page, category, `E2E invoice ${stamp}`, 500, false);

  await gotoRoute(page, "expenses", "Expenses");
  await page.getByRole("tab", { name: /^All/ }).click();

  // Reject: the canned-reason chips write the textarea rather than requiring one to be typed, and the row
  // keeps the reason on it afterwards - not just a badge saying it was refused, but why.
  const rejectRow = page.locator("tbody tr").filter({ hasText: rejected.description });
  await expect(rejectRow).toBeVisible({ timeout: 30_000 });
  await rejectRow.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Reject with a reason" }).click();
  const rejectDialog = page.getByRole("dialog").filter({ hasText: "Reject expense" });
  await expect(rejectDialog).toBeVisible();
  await rejectDialog.getByRole("button", { name: "Missing invoice" }).click();
  await expect(rejectDialog.getByLabel("Reason")).toHaveValue(/Missing the vendor invoice/);
  await rejectDialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(toast(page, "Rejected")).toBeVisible({ timeout: 30_000 });
  await expect(rejectRow).toContainText("Rejected");
  await expect(rejectRow).toContainText("Missing the vendor invoice");

  // Cancel: a draft nobody submitted, withdrawn outright rather than left to expire.
  const cancelRow = page.locator("tbody tr").filter({ hasText: cancelled.description });
  await expect(cancelRow).toBeVisible();
  await cancelRow.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Cancel", exact: true }).click();
  const cancelDialog = page.getByRole("dialog").filter({ hasText: "Cancel this request?" });
  await expect(cancelDialog).toBeVisible();
  await cancelDialog.getByRole("button", { name: "Cancel request", exact: true }).click();
  await expect(toast(page, "Cancelled")).toBeVisible({ timeout: 30_000 });
  await expect(cancelRow).toContainText("Cancelled");

  // Invoice: attached from the row menu (not the create form, which never touches this code path), then read
  // back both ways - viewed in place and downloaded - because a reviewer who can only download it has to leave
  // the queue to decide, and one who can only view it can never keep a copy.
  const invoiceRow = page.locator("tbody tr").filter({ hasText: invoiced.description });
  await expect(invoiceRow).toBeVisible();
  await invoiceRow.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Attach invoice" }).click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "e2e-invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%E2E test invoice\n"),
  });
  await expect(toast(page, "Invoice attached")).toBeVisible({ timeout: 30_000 });

  await invoiceRow.getByRole("button", { name: "Actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Replace invoice" })).toBeVisible(); // relabelled now one exists
  await page.getByRole("menuitem", { name: "View invoice" }).click();
  const viewer = page.getByRole("dialog").filter({ hasText: "Invoice ·" });
  await expect(viewer.getByTitle(/Invoice/)).toBeVisible({ timeout: 30_000 });
  // Closed by its own control first, then Escape, then - if this viewer is still up after a few passes - a
  // reload. Escape has proven unreliable at closing a dialog under load elsewhere in this suite, and this one
  // holds an iframe, which is the case where retrying the same keypress forever gets nowhere. A reload costs
  // this test nothing: everything it still needs is read off the row again below.
  let attempts = 0;
  await expect(async () => {
    if (!(await viewer.count())) return;
    attempts += 1;
    const close = viewer.getByRole("button", { name: /close/i });
    if (await close.count()) await close.first().click({ timeout: 5_000 }).catch(() => undefined);
    else await page.keyboard.press("Escape");
    if (attempts > 2 && (await viewer.count())) {
      await page.reload();
      await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
    }
    await expect(viewer).toHaveCount(0, { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });

  await invoiceRow.getByRole("button", { name: "Actions" }).click();
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download invoice" }).click(),
  ]);
  // The name the UPLOADER gave it, not one the client invents: a stored attachment is saved under the name
  // the server sends in `Content-Disposition`, which is the only side that knows it (web/src/lib/download.ts).
  expect(dl.suggestedFilename()).toBe("e2e-invoice.pdf");
});

// A category can require a receipt (`expense-categories.requires_receipt`) - and that requirement is enforced
// ONLY in this form, client-side: `submitExpense`/`createExpense` server-side never check it. So the Save
// button being disabled until a file is attached is not a nicety here, it is the entire rule; nothing server-
// side would catch a form that let this one through.
test("a receipt-required category blocks Save until an invoice is attached", async ({ as }) => {
  // Longer than the 150s the retry below budgets itself - a test timeout shorter than an inner .toPass()'s own
  // window kills the retry mid-flight on a slow-to-populate categories fetch and reports it as the TEST timing
  // out rather than ever letting the retry actually use the time it was given.
  test.setTimeout(240_000);
  const page = await as("super");
  await gotoRoute(page, "expenses", "Expenses");

  const form = page.getByRole("dialog");
  // Seeded category with requires_receipt = true (scripts/seed.sql), distinct from "Office Supplies" which
  // every other expense spec deliberately picks to AVOID this exact requirement.
  const travel = page.getByRole("option", { name: /Travel & Transport/ });
  // Opened, picked and confirmed as ONE retried unit, re-opening the dialog when it is gone. Radix renders
  // this option list in a PORTAL outside the dialog, and a press that lands on a closing one reads as an
  // interaction outside the dialog and dismisses the whole form - after which every later press on its
  // combobox waits on an element that no longer exists, for the whole retry budget. The option press is
  // unforced for the same reason (`expenses.spec.ts` documents this trap too).
  await expect(async () => {
    if (!(await form.count())) {
      await page.getByRole("button", { name: "New expense" }).first().click({ timeout: 10_000 });
      await expect(form.getByRole("heading", { name: "New expense" })).toBeVisible({ timeout: 15_000 });
    }
    const category = form.getByRole("combobox").first();
    await expect(category).toBeEnabled({ timeout: 45_000 });
    if (!(await travel.count())) await category.click({ timeout: 15_000 });
    await expect(travel).toBeVisible({ timeout: 10_000 });
    await travel.click({ timeout: 10_000 });
    await expect(form.getByText("This category requires an invoice.")).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 150_000 });
  await form.getByLabel("Amount").fill("1500");
  await form.getByLabel(/Description/).fill(`E2E receipt-required ${Date.now()}`);
  const saveBtn = form.locator('button[type="submit"]');
  await expect(saveBtn).toBeDisabled();

  await form.locator('input[type="file"]').setInputFiles({
    name: "e2e-receipt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%E2E test receipt\n"),
  });
  await expect(form.getByText("This category requires an invoice.")).toHaveCount(0);
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await expect(toast(page, "Expense submitted")).toBeVisible({ timeout: 30_000 });
});

/** The seeded, no-invoice-required category `expenses.spec.ts` also relies on - its wire path, over the API. */
async function officeSupplies(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get("/v1/expense-categories?page_size=200");
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  const found = results.find((c) => /office supplies/i.test(c.display_name ?? ""));
  if (!found) throw new Error("e2e: seeded 'Office Supplies' expense category not found");
  return found.path;
}

/** A draft expense, optionally moved to SUBMITTED - created over the wire so the test drives only the row
 *  action it is actually about. */
async function createExpense(page: import("@playwright/test").Page, category: string, description: string, amount: number, submit: boolean): Promise<{ path: string; description: string }> {
  const made = await page.request.post("/v1/expenses", { headers: SPA_HEADERS, data: { category, amount, description } });
  expect(made.status(), await made.text()).toBe(200);
  const row = (await made.json()) as { path: string };
  if (submit) {
    const res = await page.request.post(`/v1/${row.path}:submit`, { headers: SPA_HEADERS });
    expect(res.status(), await res.text()).toBeLessThan(300);
  }
  return { path: row.path, description };
}
