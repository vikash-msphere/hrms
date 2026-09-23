import { SPA_HEADERS, gotoRoute, inDays, purge, test, expect, toast } from "./fixtures";

// "Copy last week" - the shortcut for a week that looks like the one before it, and never pressed anywhere.
// `timesheets.spec.ts` logs and submits a week by hand; this is the other way hours land on the grid, and it
// has its own rule worth pinning: it only fills days that are still BLANK (a day the grid already has an
// entry for is left alone), which is what makes it safe to press on a week that is already partly filled in.
test("Copy last week fills this week's blank days from last week's entries", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const hr = await as("hr");
  await purgeEntries(employee);
  await purgeProjects(hr);
  const { path: project, name: projectName } = await makeProject(hr);

  // Last week's hours, written directly - composing THIS week's grid by hand is `timesheets.spec.ts`'s
  // subject, and exactly seven days back is guaranteed to fall in the week before whichever week today's is.
  const sourceDate = inDays(-7);
  const made = await employee.request.post("/v1/time-entries", {
    headers: SPA_HEADERS,
    data: { project, date: sourceDate, hours: 3, description: "E2E timesheet copy-source", billable: true },
  });
  expect(made.status(), await made.text()).toBe(200);
  const sourcePath = ((await made.json()) as { path: string }).path;

  try {
    await gotoRoute(employee, "timesheets", "Timesheets");
    await employee.locator("button:visible").filter({ hasText: "Add project" }).first().click();
    await employee.getByRole("option", { name: projectName, exact: true }).click();

    const cell = (state: string) => employee.getByRole("button", { name: new RegExp(`^${projectName}, [\\d-]+, ${state}$`) });
    await expect(cell("no hours logged").first()).toBeVisible();

    // Checked by the cell landing the hours, not only by the toast: a toast that renders after this test has
    // stopped watching for it is a lost race on the confirmation, not proof the copy itself never happened,
    // and re-pressing on that assumption would find every day already filled and get "Nothing to copy" back
    // instead - a real failure this test did not cause.
    await employee.getByRole("button", { name: "Copy last week" }).click();
    await expect(cell("3 hours").first()).toBeVisible({ timeout: 30_000 });

    // Pressed again: every day it could have filled is now taken, so there is nothing left to copy. Proven by
    // the register not growing rather than by the toast alone - for the same reason the first press is checked
    // on the cell (above): a toast lives about five seconds, a loaded machine misses it, and "nothing was
    // copied" is a fact about the entries, not about whether the notification was caught.
    const before = await entriesFor(employee, project);
    await employee.getByRole("button", { name: "Copy last week" }).click();
    await expect(toast(employee, "Nothing to copy")).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
    await expect
      .poll(() => entriesFor(employee, project), { timeout: 15_000, message: "a second copy wrote more entries" })
      .toBe(before);
  } finally {
    await purge(employee, sourcePath);
    await purgeEntries(employee);
    await purge(hr, project);
  }
});

async function makeProject(page: import("@playwright/test").Page): Promise<{ path: string; name: string }> {
  // "copy-last-week-project" rather than the bare "E2E project" other timesheet specs also use:
  // `purgeProjects` below sweeps by prefix, and a shared one lets two of these specs, run concurrently, delete
  // each other's still-in-use project mid-test. Hyphenated, not parenthesised - `cell()` below builds a
  // RegExp straight out of this name, and `(`/`)` in it become an unintended capture group that matches nothing.
  const name = `E2E copy-last-week-project ${Date.now()}`;
  const res = await page.request.post("/v1/projects", { headers: SPA_HEADERS, data: { name, billable: true } });
  expect(res.status(), await res.text()).toBe(200);
  return { path: ((await res.json()) as { path: string }).path, name };
}

/** How many time entries this spec's own project carries - what a copy that copied nothing leaves unchanged. */
async function entriesFor(page: import("@playwright/test").Page, project: string): Promise<number> {
  const res = await page.request.get("/v1/time-entries?page_size=200");
  if (!res.ok()) return -1;
  const { results = [] } = (await res.json()) as { results?: { project?: string }[] };
  return results.filter((e) => e.project === project).length;
}

async function purgeEntries(page: import("@playwright/test").Page) {
  const entries = await page.request.get("/v1/time-entries?page_size=100");
  if (!entries.ok()) return;
  const { results = [] } = (await entries.json()) as { results?: { path: string; description?: string }[] };
  for (const e of results.filter((x) => (x.description ?? "").startsWith("E2E timesheet"))) await purge(page, e.path);
}

async function purgeProjects(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/projects?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string; display_name?: string }[] };
  for (const p of results.filter((x) => (x.name ?? x.display_name ?? "").startsWith("E2E copy-last-week-project"))) await purge(page, p.path);
}
