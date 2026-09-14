import { gotoRoute, purge, test, expect } from "./fixtures";

// Background verification: five checks per hire, or one at a time.
//
// The form's own affordance is the interesting part - a switch that turns "add a check" into "add the whole
// standard set", with the submit button counting what it is about to create. That is a decision made in the
// rendered form, and getting it wrong means either five dialogs per hire or an accidental five rows.
test("the standard set of checks is added for one employee in a single press", async ({ as }) => {
  const page = await as("hr");
  // The vendor this order is placed with - and, because it rides every row of the set, the only way to
  // count THIS press's rows. The table is shared with `backgroundCheckFlow.spec.ts` beside it and with
  // whatever an earlier run of the lane left on Eve (`E2E_KEEP_DB=1`), so "how many checks does Eve have"
  // is not a number this spec gets to assume.
  const vendor = `E2E set ${Date.now()}`;

  await gotoRoute(page, "background-checks", "Background Verification");
  await sweep(page);
  await page.getByRole("button", { name: "Add check" }).first().click();
  const form = page.getByRole("dialog");

  await form.getByLabel("Employee").click();
  await page.getByPlaceholder(/Search|Select/).last().fill("Eve");
  await expect(page.getByRole("option", { name: /Eve Employee/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await form.getByLabel("Vendor / agency").fill(vendor);

  // One check by default; the switch turns it into the whole standard set, and the button says how many.
  await expect(form.getByRole("button", { name: "Add check", exact: true })).toBeVisible();
  await form.getByRole("checkbox").first().click();
  const addSet = form.getByRole("button", { name: /^Add \d+ checks$/ });
  await expect(addSet).toBeVisible();
  const expected = Number(((await addSet.innerText()) || "").replace(/\D+/g, ""));
  await addSet.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Exactly that many rows arrived, all on the one person - counted through the vendor this press stamped
  // on them, so neither a neighbouring spec nor an earlier run can pad the number.
  const rows = page.locator("tbody tr").filter({ hasText: "Eve Employee" }).filter({ hasText: vendor });
  await expect(rows).toHaveCount(expected);

  await sweep(page);
});

type Page = import("@playwright/test").Page;

/**
 * Take out every check any run of this spec has ever ordered.
 *
 * By vendor, not by "everything on the page": the neighbouring `backgroundCheckFlow.spec.ts` is writing to
 * this table at the same time, and a blanket purge would delete the row it is half way through walking.
 */
async function sweep(page: Page) {
  const res = await page.request.get("/v1/background-checks?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; vendor?: string }[] };
  for (const c of results.filter((r) => (r.vendor ?? "").startsWith("E2E set "))) await purge(page, c.path);
}
