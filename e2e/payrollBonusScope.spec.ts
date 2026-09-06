import { gotoRoute, test, expect } from "./fixtures";

// The one thing between "award a bonus" and "just paid the whole company by accident": the live headcount
// and total this form computes as the scope changes, BEFORE anything is sent - and says again, unprompted, at
// the confirm checkpoint. `compensation.spec.ts` owns the individual award landing on one person's record;
// this owns the wider two (company-wide, a whole department) `PayrollBonuses.tsx` alone can make, and the
// arithmetic that has to be right every time the scope changes rather than only on the day someone checked it
// by hand. Nothing here is submitted - the recipients/total math and the confirm text are provable, and worth
// pinning, without ever materializing the batch `test/bonuses.test.ts` already owns.
test("switching a bonus's scope recomputes who it reaches and what it costs, before and at the checkpoint", async ({ as }) => {
  test.setTimeout(120_000);
  // An admin, because the two grants this needs are held by different roles in the seeded matrix and awarding
  // is deliberately ACL-only: `payroll-runs` (the page the Bonuses tab lives on) is payroll_admin's, `bonuses`
  // write is hr_admin's, and neither is given `bonuses:award` - an org hands that out in the access UI. HR
  // therefore meets the page's wall and payroll never sees the button, both of which are the app being right.
  const page = await as("super");

  // Every row, by the cursor. `?page_size=` is not a parameter the API has - the page size is `max_page_size`,
  // clamped to 100 (src/http/pagination.ts), and anything else falls back to the default 50. Reading half the
  // roster and then asserting the form's headcount against it compares two different companies.
  const [employees, departments] = await Promise.all([
    all<{ path: string; department?: string; delete_time?: string }>(page, "employees"),
    all<{ path: string; display_name: string }>(page, "departments"),
  ]);
  const live = employees.filter((e) => !e.delete_time);
  // A department with at least one live employee AND fewer than the whole company - otherwise switching
  // scope wouldn't actually change the number this spec is reading.
  const dept = departments
    .map((d) => ({ ...d, count: live.filter((e) => e.department && e.department.split("/")[1] === d.path.split("/")[1]).length }))
    .find((d) => d.count > 0 && d.count < live.length);
  expect(dept, "need a department with some but not all employees to prove the count actually changes").toBeTruthy();

  await gotoRoute(page, "payroll-runs", "Payroll");
  await page.getByRole("tab", { name: "Bonuses" }).click();
  await page.getByRole("button", { name: "Award bonus" }).click();
  const form = page.getByRole("dialog");
  await expect(form.getByText("Award bonus")).toBeVisible();

  const amount = "1000";
  await form.getByLabel(/^Amount/).fill(amount);

  // Company-wide first (the form's own default scope): every live employee.
  await expect(form.getByText(`× ${live.length} ${live.length === 1 ? "person" : "people"}`)).toBeVisible({ timeout: 15_000 });
  await expect(form.getByText(`₹${(1000 * live.length).toLocaleString("en-US")}`)).toBeVisible();

  // Narrowed to one department: a smaller, different number, recomputed live off the same amount.
  await form.getByLabel("Who").click();
  await page.getByRole("option", { name: "A department" }).click();
  await form.getByLabel("Department").click();
  await page.getByRole("option", { name: dept!.display_name, exact: true }).click();
  await expect(form.getByText(`× ${dept!.count} ${dept!.count === 1 ? "person" : "people"}`)).toBeVisible({ timeout: 15_000 });
  await expect(form.getByText(`₹${(1000 * dept!.count).toLocaleString("en-US")}`)).toBeVisible();

  // The confirm checkpoint repeats the SAME numbers, out loud, before anything is sent - not asserted from a
  // toast afterwards, because there is no "afterwards" here: this spec declines it.
  // "Award" inside the dialog; "Award bonus" is the page button that opened it.
  await form.getByRole("button", { name: "Award", exact: true }).click();
  const confirmDialog = page.getByRole("dialog").filter({ hasText: /Award this bonus to/ });
  await expect(confirmDialog.getByText(`Award this bonus to ${dept!.count} ${dept!.count === 1 ? "person" : "people"}?`)).toBeVisible({ timeout: 15_000 });
  await expect(confirmDialog.getByText(`₹${(1000 * dept!.count).toLocaleString("en-US")} in total`)).toBeVisible();
  await confirmDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // One employee: the per-person preview line disappears entirely rather than reading "× 1 person" - a
  // single recipient has nothing left to multiply.
  await form.getByLabel("Who").click();
  await page.getByRole("option", { name: "One employee" }).click();
  await expect(form.getByText(/×.*person/)).toHaveCount(0);

  await page.keyboard.press("Escape");
  const discard = page.getByRole("button", { name: /Discard|Leave/ });
  if (await discard.count()) await discard.first().click();
});

/** Every row of a collection, following the server's cursor to the end. */
async function all<T>(page: import("@playwright/test").Page, collection: string): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ max_page_size: "100" });
    if (token) params.set("page_token", token);
    const res = await page.request.get(`/v1/${collection}?${params.toString()}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { results?: T[]; next_page_token?: string };
    out.push(...(body.results ?? []));
    token = body.next_page_token;
  } while (token);
  return out;
}
