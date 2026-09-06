import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

type Cat = { path: string; display_name?: string; gl_code?: string };

// The expense-category name clash and the "what this category is carrying" summary - `catalogEditors.spec.ts`
// only ever creates ONE bare-named category per catalog, so nothing here has ever run: a name that repeats
// another LIVE category is flagged (two categories with one name silently split a budget's spend across
// both and read identically on every picker) but deliberately does NOT block the save - "Travel" and
// "Travel (intl)" are a real distinction, and a genuine near-duplicate has to stay possible. And on an
// EDIT, the dialog counts what the category is actually carrying (committed expenses, budget caps) so a
// rename or a retire is made knowing what it touches, not blind.
test("a repeated category name is flagged but still saves, and the edit dialog counts what it carries", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const stamp = Date.now();
  const nameA = `E2E expense category ${stamp}`;

  await gotoRoute(page, "settings/expenses");
  await page.getByRole("tab", { name: "Categories" }).click();

  // A: the first of its name, so nothing to clash with yet. A GL code of its own is the only thing that
  // will tell the two twin rows apart once the duplicate exists.
  await page.getByRole("button", { name: "New category" }).first().click();
  let form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(nameA);
  await expect(form.getByText(/already exists/)).toHaveCount(0);
  await form.getByLabel("GL code (optional)").fill("ZZKEEP");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(nameA).first()).toBeVisible({ timeout: 30_000 });

  try {
    // B: the exact same name - flagged, but the Create button never disables over it.
    await page.getByRole("button", { name: "New category" }).first().click();
    form = page.getByRole("dialog");
    const submit = form.getByRole("button", { name: "Create", exact: true });
    await form.getByLabel("Name").fill(nameA);
    await expect(form.getByText(`"${nameA}" already exists`, { exact: false })).toBeVisible();
    await expect(form.getByText("split their spend across two budgets", { exact: false })).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // Both rows are real - the app never refused the second, so there are genuinely two to take back out.
    let listed = await page.request.get("/v1/expense-categories?page_size=200");
    let { results = [] } = (await listed.json()) as { results?: Cat[] };
    const twins = results.filter((c) => c.display_name === nameA);
    expect(twins.length, "both the original and its deliberate near-duplicate should exist").toBe(2);

    // A committed expense against the one carrying "ZZKEEP" - the GL code is what lets the table row and
    // the API record agree on which twin this is, since the two are otherwise identical on screen.
    const catA = twins.find((c) => c.gl_code === "ZZKEEP")!;
    expect(catA, "the original (GL ZZKEEP) is not among the twins").toBeTruthy();
    const made = await page.request.post("/v1/expenses", { headers: SPA_HEADERS, data: { amount: 2500, description: `E2E clash spend ${stamp}`, category: catA.path } });
    expect(made.status(), await made.text()).toBe(200);
    const expense = (await made.json()) as { path: string };
    await page.request.post(`/v1/${expense.path}:submit`, { headers: SPA_HEADERS });
    const approved = await page.request.post(`/v1/${expense.path}:approve`, { headers: SPA_HEADERS });
    expect(approved.status(), await approved.text()).toBe(200);

    // The twin WITHOUT the expense sorts alongside this one under the same name, so the GL code is what
    // picks the row the spend actually landed on - "the first row with this name" is a coin toss.
    const row = page.locator("tbody tr").filter({ hasText: nameA }).filter({ hasText: "ZZKEEP" }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByText(/Carrying 1.* expense.*worth/)).toBeVisible({ timeout: 15_000 });
    await expect(edit.getByText("no budget caps it", { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog");
    if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
      await discard.getByRole("button", { name: /Discard|Leave/ }).click();
    }

    await purge(page, expense.path);
    listed = await page.request.get("/v1/expense-categories?page_size=200");
    ({ results = [] } = (await listed.json()) as { results?: Cat[] });
    for (const c of results.filter((c) => c.display_name === nameA)) await purge(page, c.path);
  } catch (e) {
    const cleanup = await page.request.get("/v1/expense-categories?page_size=200");
    if (cleanup.ok()) {
      const { results = [] } = (await cleanup.json()) as { results?: Cat[] };
      for (const c of results.filter((c) => c.display_name === nameA)) await purge(page, c.path);
    }
    throw e;
  }
});
