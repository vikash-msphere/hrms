import { gotoRoute, inDays, purge, expect, test } from "./fixtures";

// Handing your approvals to somebody while you are away.
//
// A delegation is a date range and a colleague, and the form's job is to say plainly what it is about to do -
// "X receives your approvals for N days, from … to …" - before it is saved, and to warn when the days are
// already covered by another delegation. Both are computed in the form as it is filled, which is the part no
// server test can see. `test/smartWorkflows` owns what a live delegation does to a queue.
// Signed in as super: the page is gated on `approval-delegations.read`, which the seeded role grants do not
// hand to anybody else - so a spec using the manager role would be testing a grant this org does not have.
test("a delegation states what it will do, and warns when the days are already covered", async ({ as }) => {
  const page = await as("super");

  await gotoRoute(page, "delegations", "Approval delegation");
  await page.getByRole("button", { name: "Add delegation" }).first().click();
  const form = page.getByRole("dialog");

  await form.getByLabel("Covered by").click();
  await page.getByPlaceholder(/Search|Pick/).last().fill("Hank");
  await expect(page.getByRole("button", { name: /Hank Hr/ })).toBeVisible();
  await page.keyboard.press("Enter");

  await form.getByLabel("From").fill(inDays(30));
  await form.getByLabel("To", { exact: true }).fill(inDays(34));
  await form.getByLabel(/Reason/).fill("E2E delegation");

  // The consequence, spelled out with the count of days it covers.
  await expect(form.getByText(/receives your approvals for 5 days/)).toBeVisible();
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Hank Hr/).first()).toBeVisible();

  // The same days again: the form says they are already covered rather than quietly stacking two
  // delegations over one window.
  await page.getByRole("button", { name: "Add delegation" }).first().click();
  const second = page.getByRole("dialog");
  await second.getByLabel("Covered by").click();
  await page.getByPlaceholder(/Search|Pick/).last().fill("Hank");
  await expect(page.getByRole("button", { name: /Hank Hr/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await second.getByLabel("From").fill(inDays(31));
  await second.getByLabel("To", { exact: true }).fill(inDays(33));
  await expect(second.getByText("These days are already covered")).toBeVisible();
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog");
  const discardBtn = discard.getByRole("button", { name: /Discard|Leave/ });
  if (await discardBtn.count()) await discardBtn.first().click();

  await purge(page, await latestDelegation(page));
});

/** The delegation this spec created. */
async function latestDelegation(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get("/v1/approval-delegations?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; reason?: string }[] };
  const row = results.find((d) => d.reason === "E2E delegation");
  if (!row) throw new Error("e2e: the delegation is not in the collection");
  return row.path;
}
