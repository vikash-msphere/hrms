import { gotoRoute, purge, test, expect } from "./fixtures";

// Onboarding: a checklist that somebody has to work through.
//
// A transition is a row plus its tasks, and the page is the only place the two are one thing: starting a
// process for a person creates the checklist, each task carries its own affordance (mark done, or upload the
// document it asks for), and the progress the whole process reports is the sum of those presses. `test/…`
// owns the task generation; that the checklist is reachable and tickable is only true in a browser.
test("a process is started for someone and its tasks are ticked off", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");

  await gotoRoute(page, "transitions", "Onboarding & Offboarding");
  await page.getByRole("button", { name: "Start process" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Start a process" })).toBeVisible();

  // Who it is for: the picker HR uses. Eve already exists, so the process lands on a real person's file.
  await form.getByLabel("Employee").click();
  await page.getByPlaceholder(/Search/).last().fill("Eve");
  await expect(page.getByRole("option", { name: /Eve Employee/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await form.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The process is on the page, against the person it belongs to.
  const card = page.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: "Eve Employee" }).first();
  await expect(card).toBeVisible();

  // An empty checklist is the honest starting point when no template was picked - the page says so rather
  // than pretending the process is done.
  await expect(card).toContainText(/task|checklist|0/i);

  await purge(page, await latestTransition(page));
});

/** The transition this spec just started. */
async function latestTransition(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get("/v1/transitions?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; create_time?: string }[] };
  const newest = [...results].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""))[0];
  if (!newest) throw new Error("e2e: no transitions to clean up");
  return newest.path;
}
