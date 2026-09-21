import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A measured goal: progress that is arithmetic, not an opinion.
//
// `test/goalMeasureDrift.test.ts` pins `measuredPct` (lib/goalMeasure.ts) against the server's own
// `measuredProgress`, so the number is right on both sides. What only a browser shows is the form computing
// that number BEFORE the goal is saved - the whole point of a live preview - and the drawer's inline "Current"
// input replacing the slider once a goal is measured, because a measure moves by typing a count, not by
// dragging an opinion.
//
// Baseline 8, target 4, current 6 is the churn example from the module's own comment: counting DOWN, and
// half done at the midpoint - the case a measure starting at zero would get wrong.
test("a measured goal previews its percentage, reports the count, and completes at target", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("manager");
  const title = `E2E measured goal ${Date.now()}`;

  await gotoRoute(page, "goals", "Goals");
  await page.getByRole("button", { name: "New goal" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "New goal" })).toBeVisible();
  await form.getByLabel("Title").fill(title);

  // The measure is folded away on a goal that has none, so asking for one is the first step.
  await form.getByRole("button", { name: "Add a measure" }).click();

  // The measure, filled in before anything is saved - the preview has to be live off the form's own state.
  await form.getByLabel("Baseline").fill("8");
  await form.getByLabel("Current").fill("6");
  await form.getByLabel("Target").fill("4");
  await form.getByLabel("Unit").fill("%");
  await expect(form.getByText("50% complete")).toBeVisible();
  await expect(form.getByText("Counting down from 8 to 4 %")).toBeVisible();

  await form.getByRole("button", { name: "Create goal" }).click();
  await expect(toast(page, "Goal created")).toBeVisible();

  const card = page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title }).last();
  await expect(card).toBeVisible();
  await card.click();

  const detail = page.getByRole("dialog");
  // The measure reads as a count, not a percentage: "6 of 4 %", with where it started alongside.
  await expect(detail.getByText("6 of 4 %")).toBeVisible();
  await expect(detail.getByText("from 8")).toBeVisible();
  // No slider for a measured goal - the count is the only thing worth editing.
  await expect(detail.getByRole("slider", { name: "Set progress" })).toHaveCount(0);

  // Move the count to the target. The label the input carries includes the unit, because a bare "Current
  // value" would be ambiguous between two measured goals open in the same drawer lineage.
  const cur = detail.getByLabel("Current value in %");
  await cur.fill("4");
  await detail.getByRole("button", { name: "Update" }).click();
  await expect(toast(page, "Target reached - goal complete")).toBeVisible();
  // The drawer re-renders the live row: the count now reads 4 of 4, and the goal completed.
  await expect(detail.getByText("4 of 4 %")).toBeVisible();
  await expect(detail.getByText(/Completed|100%/).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await purge(page, await goalPath(page, title));
});

async function goalPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/goals?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[] };
  const row = results.find((g) => (g.title ?? g.display_name) === title);
  if (!row) throw new Error(`e2e: the goal "${title}" is not in the collection`);
  return row.path;
}
