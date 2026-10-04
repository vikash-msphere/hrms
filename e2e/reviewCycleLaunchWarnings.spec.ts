import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The launch preview's three warnings - `reviews.spec.ts` already drives the create → pick → preview →
// launch shape end to end, but picks a seeded person (Eve) who trips none of them: she has a manager,
// joined years ago, and is off probation. None of the three has ever actually rendered. All three are
// legitimate (HR is the one who knows), so none of them blocks the launch - they are named so the person
// pressing it can see who, not to stop them.
test("launching at someone with no manager, who joined late and is on probation names all three", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
  const stamp = Date.now();
  const cycleName = `E2E launch warnings ${stamp}`;
  const empName = `E2Elaunch${stamp}`;

  // A fresh person built to trip every warning at once: no manager, started well after the period this
  // cycle will claim to cover, and still on probation for a year yet.
  const madeEmp = await hr.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: {
      first_name: empName,
      last_name: "Warnings",
      work_email: `${empName.toLowerCase()}@example.com`,
      start_date: new Date().toISOString().slice(0, 10),
      probation_end_date: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
    },
  });
  expect(madeEmp.status(), await madeEmp.text()).toBe(200);
  const employee = (await madeEmp.json()) as { path: string };
  const fullName = `${empName} Warnings`;

  await gotoRoute(hr, "settings/performance", "Performance framework");
  await hr.getByRole("tab", { name: "Review cycles" }).click();
  await hr.getByRole("button", { name: /New cycle|Create cycle|New review cycle/ }).first().click();
  const form = hr.getByRole("dialog");
  await form.getByLabel("Name").fill(cycleName);
  // Long before anyone here joined - the period this cycle claims to cover starts decades before the fresh
  // hire's own first day, which is exactly what "joined late" means.
  await form.getByLabel("Period start (optional)").fill("2000-01-01");
  await form.getByRole("button", { name: /^(Create|Save)/ }).last().click();
  await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const card = hr.locator("div.shadow-card").filter({ hasText: cycleName }).first();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Launch" }).click();
  const picker = hr.getByRole("dialog");
  await picker.getByRole("searchbox", { name: "Search name…" }).fill(fullName);
  await picker.getByRole("checkbox").last().click();
  await picker.getByRole("button", { name: "Review and launch" }).click();

  try {
    const preview = hr.getByRole("dialog");
    await expect(preview.getByText("1 review will be created")).toBeVisible();
    await expect(preview.getByText(`${fullName} has no manager`, { exact: false })).toBeVisible();
    await expect(preview.getByText("One person joined after the period started", { exact: false })).toBeVisible();
    await expect(preview.getByText("One person is still on probation", { exact: false })).toBeVisible();
    // The all-clear line is the OTHER branch of this same condition - it must not also be showing.
    await expect(preview.getByText("Everyone picked has a manager and was here for the whole period.")).toHaveCount(0);

    // "Change who" reopens a genuinely blank picker - it is a fresh pick, not the same selection re-offered
    // for editing, so the same person has to be found and checked again.
    await preview.getByRole("button", { name: "Change who" }).click();
    await expect(picker.getByRole("checkbox").last()).not.toBeChecked();
    await picker.getByRole("searchbox", { name: "Search name…" }).fill(fullName);
    await picker.getByRole("checkbox").last().click();
    await picker.getByRole("button", { name: "Review and launch" }).click();
    await expect(preview.getByText(`${fullName} has no manager`, { exact: false })).toBeVisible();

    await preview.getByRole("button", { name: /^Launch for 1/ }).click();
    await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(card).toContainText(/Active/i);
  } finally {
    const cleanup = await as("super");
    const res = await cleanup.request.get("/v1/review-cycles?page_size=100");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
      const cycle = results.find((c) => c.name === cycleName);
      if (cycle) await purge(cleanup, cycle.path);
    }
    await purge(cleanup, employee.path);
  }
});
