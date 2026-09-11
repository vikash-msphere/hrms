import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A company expense walked from filed to paid, through the queues the page is built around.
//
// `test/expensesFlow.test.ts` owns the state machine over the wire. What only a browser shows is that the
// machine is REACHABLE: an expense lands in the "To approve" queue, approving moves it out of that queue and
// into "To pay", paying takes it out of that one, and the ledger agrees at the end. Each step asks first,
// because each step is somebody else's money. An expense whose "Mark paid" never appears is a bill nobody
// can close, and no server test can see that.
test("an expense moves through the approve and pay queues, asking at each step", async ({ as }) => {
  // Longer than the 90s an inner .toPass() below budgets itself - a default 30s test timeout shorter than an
  // inner retry's own window kills the retry mid-flight on a slow-to-populate categories fetch and reports it
  // as the TEST timing out rather than ever letting the retry actually use the time it was given.
  test.setTimeout(220_000);
  const page = await as("super");
  await gotoRoute(page, "expenses", "Expenses");

  const rupees = 20000 + Math.floor(Math.random() * 9000);
  const what = `E2E expense ${Date.now()}`;

  const form = page.getByRole("dialog");
  // "Office Supplies" is the seeded category that needs no invoice attached.
  const category = form.getByRole("combobox").first();
  const office = page.getByRole("option", { name: /Office Supplies/ });

  // Opened, picked and CHECKED as one retried unit, from the "New expense" press down.
  //
  // Every step here is against a form that rewrites itself as its own lists land - categories, vendors,
  // departments, the budget line - and each arrival moves the fields below by a few pixels. So the picker
  // stays disabled until the categories are in, and a press that lands while the TRIGGER is still moving is
  // swallowed - which is why that one press is forced.
  //
  // The OPTION press is deliberately NOT forced. The listbox is portaled OUTSIDE the dialog, so a forced
  // pointer event landing on it while it is already closing arrives at the dialog's dismissable layer as an
  // interaction from outside - and Radix closes the DIALOG. That is what "Amount is not in this dialog" was:
  // by the time the field was asked for, there was no dialog left on the page at all. Unforced, Playwright
  // waits for the option to be stable instead, which the popover is once it is open (it is the fields
  // underneath that move, not the list), and the press cannot be delivered anywhere else.
  //
  // Retrying only the innermost press left the outer cases - a lost press on New expense, a picker that
  // closed with nothing chosen, a dialog dismissed out from under it - unrecoverable, so the whole sequence
  // is re-driven from whatever state it finds, and it is the picker READING BACK "Office Supplies" IN AN
  // OPEN DIALOG that ends it, not merely a press having been made.
  await expect(async () => {
    if (!(await form.count())) {
      await page.getByRole("button", { name: "New expense" }).first().click({ timeout: 8_000 });
      await expect(form.getByRole("heading", { name: "New expense" })).toBeVisible({ timeout: 15_000 });
    }
    if (!(await category.textContent())?.includes("Office Supplies")) {
      await expect(category).toBeEnabled({ timeout: 45_000 });
      if (!(await office.count())) await category.click({ force: true, timeout: 8_000 });
      await expect(office).toBeVisible({ timeout: 8_000 });
      await office.click({ timeout: 8_000 });
      await expect(category).toContainText(/Office Supplies/, { timeout: 8_000 });
    }
    // Still open, and still carrying the rest of the form: a dialog dismissed by the press above is the
    // failure this whole block exists to catch, and it has to be caught HERE rather than several fields later.
    await expect(form.getByLabel("Amount")).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 120_000 });
  // Retried: the form keeps re-rendering as its own lists resolve (categories, vendors, departments, the
  // budget line), and a fill can land on a field mid-detach from one of those re-renders same as the category
  // picker above.
  await expect(async () => {
    await form.getByLabel("Amount").fill(String(rupees), { timeout: 8_000 });
    await expect(form.getByLabel("Amount")).toHaveValue(String(rupees), { timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  await form.getByLabel(/Description/).fill(what);
  // The checkbox that decides whether this is a draft or goes straight for approval: on, by default.
  await expect(form.getByLabel("Submit for approval now")).toBeChecked();
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(toast(page, "Expense submitted")).toBeVisible();

  // The approval queue - the tab this page opens on for anybody who can decide.
  await page.getByRole("tab", { name: /^To approve/ }).click();
  const inReview = page.locator("tbody tr").filter({ hasText: what });
  await expect(inReview).toHaveCount(1);

  await inReview.getByRole("button", { name: "Approve", exact: true }).click();
  const approve = page.getByRole("dialog");
  await expect(approve.getByText("Approve this request?")).toBeVisible();
  // The dialog names the expense it is deciding, so it can never be mistaken for the row above or below.
  await expect(approve).toContainText(what);
  await approve.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(toast(page, "Approved")).toBeVisible();
  await expect(page.locator("tbody tr").filter({ hasText: what })).toHaveCount(0);

  // Approved and owed: it is now in the payables queue, and nowhere else. The queue is its own server-side
  // read, so this is what a person who has just approved something and gone to pay it actually does.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("tab", { name: /^To pay/ }).click();
  const payable = page.locator("tbody tr").filter({ hasText: what });
  await expect(payable).toHaveCount(1);

  await payable.getByRole("button", { name: "Mark paid", exact: true }).click();
  const pay = page.getByRole("dialog");
  await expect(pay.getByLabel(/Payment reference/)).toBeVisible();
  await pay.getByLabel(/Payment reference/).fill("E2E-UTR-1");
  await pay.getByRole("button", { name: "Mark paid", exact: true }).click();
  await expect(toast(page, "Marked paid")).toBeVisible();
  await expect(page.locator("tbody tr").filter({ hasText: what })).toHaveCount(0);

  // And the ledger has it, paid - which is the state surviving a reload rather than living in this browser.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  // Not `exact`: the tab carries a "new since you last looked" badge, so its accessible name is "All 1" as
  // often as it is "All".
  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(page.locator("tbody tr").filter({ hasText: what })).toContainText(/Paid/i);

  await purge(page, await expensePath(page, what));
});

/** The wire path of the expense this spec filed. */
async function expensePath(page: import("@playwright/test").Page, description: string): Promise<string> {
  const res = await page.request.get("/v1/expenses?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; description?: string }[] };
  const row = results.find((r) => r.description === description);
  if (!row) throw new Error(`e2e: the expense "${description}" is not in the collection`);
  return row.path;
}
