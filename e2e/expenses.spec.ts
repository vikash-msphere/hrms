import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A company expense walked from filed to paid, through the queues the page is built around.
//
// `test/expensesFlow.test.ts` owns the state machine over the wire. What only a browser shows is that the
// machine is REACHABLE: an expense lands in the "To approve" queue, approving moves it out of that queue and
// into "To pay", paying takes it out of that one, and the ledger agrees at the end. Each step asks first,
// because each step is somebody else's money. An expense whose "Mark paid" never appears is a bill nobody
// can close, and no server test can see that.
test("an expense moves through the approve and pay queues, asking at each step", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "expenses", "Expenses");

  const rupees = 20000 + Math.floor(Math.random() * 9000);
  const what = `E2E expense ${Date.now()}`;

  await page.getByRole("button", { name: "New expense" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "New expense" })).toBeVisible();
  // "Office Supplies" is the seeded category that needs no invoice attached. The picker stays disabled until
  // the categories are in - there is nothing to choose from before that - so it is waited for rather than
  // clicked at: on a busy lane that fetch queues behind fifteen other browsers.
  const category = form.getByRole("combobox").first();
  await expect(category).toBeEnabled({ timeout: 45_000 });
  // Pressed rather than waited into stillness. The form fills itself in as its lists land - categories,
  // vendors, departments, the budget line - and each arrival moves the fields below by a few pixels, so on a
  // busy lane the picker can be enabled and hit-testable for a long time without ever holding the same
  // position for the two consecutive frames Playwright wants. A person clicks it anyway.
  // Pressed until the list is actually open: a press that lands while the field is moving can be swallowed,
  // and a picker that did not open is not a failure worth a stack trace - it is a button somebody presses
  // again.
  const office = page.getByRole("option", { name: /Office Supplies/ });
  await expect(async () => {
    if (!(await office.count())) await category.click({ force: true, timeout: 15_000 });
    await expect(office).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await office.click({ force: true });
  await form.getByLabel("Amount").fill(String(rupees));
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
