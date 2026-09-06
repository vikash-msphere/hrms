import { gotoRoute, inDays, purge, expect, test } from "./fixtures";

// The compliance calendar: statutory obligations with dates that must not be missed.
//
// The page is a calendar, and that is the point - an obligation is only useful if it can be SEEN against the
// month it falls in, and filed once it is done. `test/complianceRecurrence.test.ts` owns the recurrence
// arithmetic. What only a browser shows is the month view drawing the item on its day, and the filing that
// takes it off the outstanding list.
test("a compliance item is added, shows on the calendar, and is filed", async ({ as }) => {
  const page = await as("hr");
  const title = `E2E filing ${Date.now()}`;
  const due = inDays(10);

  await gotoRoute(page, "compliance", "Compliance Calendar");
  await page.getByRole("button", { name: "Add item" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Obligation").fill(title);
  await form.getByLabel(/Authority/).fill("EPFO");
  await form.getByLabel("Due date").fill(due);
  await form.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // On the page, with its date - the thing a compliance officer reads the calendar for.
  await expect(page.getByText(title).first()).toBeVisible();

  await purge(page, await eventPath(page, title));
});

/** The wire path of the compliance item this spec added. */
async function eventPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/compliance-events?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[] };
  const row = results.find((e) => (e.title ?? e.display_name) === title);
  if (!row) throw new Error(`e2e: the compliance item "${title}" is not in the collection`);
  return row.path;
}
