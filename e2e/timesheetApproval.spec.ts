import { SPA_HEADERS, gotoRoute, inDays, purge, test, expect } from "./fixtures";

// The other side of a submitted week.
//
// `timesheets.spec.ts` ends where a person hands their week over. This picks it up at the manager's desk:
// submitted entries surface on the SAME page the manager logs their own hours on, in an "awaiting your
// approval" band above the grid, because a manager's week and their team's week are one visit. Approving is
// a per-entry decision (hours are approved line by line, not as a lump), and the entry's state has to change
// under both people - the approver's band empties and the submitter's cell stops saying pending.
test("a submitted week reaches the manager's own timesheet page, and approving clears it", async ({ as }) => {
  test.setTimeout(180_000);
  const employee = await as("employee");
  const manager = await as("manager");
  // The project catalog is HR's to keep (`projects.**: write` sits in the hr_admin grant), so the fixture
  // project is made by HR rather than by the manager who will approve time logged against it.
  const hr = await as("hr");
  const stamp = Date.now();

  // A project and a submitted entry, over the wire: the grid is `timesheets.spec.ts`'s subject, and what is
  // being tested here starts once a week has been handed over.
  // Anything an interrupted run left pending would sit in the same band and be approved instead of this
  // spec's entry, so the queue is cleared of this spec's own leftovers first.
  await purgeLeftovers(hr);
  const project = await makeProject(hr, `E2E approval project ${stamp}`);
  const entry = await logAndSubmit(employee, project.path);

  await gotoRoute(manager, "timesheets", "Timesheets");

  // The band: a decision the manager owes, on the page they already had open.
  const band = manager.locator("div").filter({ hasText: /Awaiting your approval/ }).last();
  await expect(band).toBeVisible({ timeout: 30_000 });
  // The row for THIS entry, not the first pending one: the band is a queue, and another spec's submission
  // may be sitting in it.
  const row = band.locator("div.rounded-md.border").filter({ hasText: project.name }).first();
  await expect(row).toBeVisible();

  // Approved line by line: an hour approved is an hour that can be billed, so it is not a lump decision -
  // and, like every decision in the app, it asks before it commits.
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  const confirm = manager.getByRole("dialog");
  await expect(confirm.getByText("Approve this request?")).toBeVisible({ timeout: 30_000 });
  await confirm.getByRole("button", { name: "Approve", exact: true }).click();

  // The decision leaves the band - asserted on the BAND rather than on the page, because the project's name
  // is also a row in the manager's own grid underneath, where it stays either way.
  await expect(async () => {
    const still = manager.locator("div").filter({ hasText: /Awaiting your approval/ }).last();
    if (await still.count()) await expect(still).not.toContainText(project.name);
  }).toPass({ timeout: 30_000 });
  const after = await manager.request.get(`/v1/${entry}`);
  expect(after.ok(), await after.text()).toBe(true);
  expect(((await after.json()) as { status?: string }).status).toBe("APPROVED");

  await purge(manager, entry);
  await purge(hr, project.path);
});

/** Drop the projects (and the hours logged against them) that earlier runs of this spec left behind. */
async function purgeLeftovers(page: import("@playwright/test").Page) {
  const projects = await page.request.get("/v1/projects?page_size=200");
  if (!projects.ok()) return;
  const { results = [] } = (await projects.json()) as { results?: { path: string; name?: string }[] };
  const mine = results.filter((p) => (p.name ?? "").startsWith("E2E approval project"));
  if (!mine.length) return;
  const entries = await page.request.get("/v1/time-entries?page_size=200");
  if (entries.ok()) {
    const { results: rows = [] } = (await entries.json()) as { results?: { path: string; project?: string }[] };
    for (const e of rows.filter((r) => mine.some((p) => p.path === r.project))) await purge(page, e.path);
  }
  for (const p of mine) await purge(page, p.path);
}

/** A project to log against - a timesheet has nothing to attach hours to without one. */
async function makeProject(page: import("@playwright/test").Page, name: string): Promise<{ path: string; name: string }> {
  const res = await page.request.post("/v1/projects", { headers: SPA_HEADERS, data: { name, billable: true } });
  expect(res.status(), await res.text()).toBe(200);
  return { path: ((await res.json()) as { path: string }).path, name };
}

/** An hour logged and handed over, so there is something waiting on a decision. */
async function logAndSubmit(page: import("@playwright/test").Page, project: string): Promise<string> {
  const made = await page.request.post("/v1/time-entries", {
    headers: SPA_HEADERS,
    // Dated three weeks back on purpose: the pending band is not week-scoped (it lists every submitted entry
    // the approver may decide), while `timesheets.spec.ts` asserts the CURRENT week's total for this same
    // employee - so an hour logged into this week would change a number another spec is reading.
    data: { project, date: inDays(-21), hours: 2, billable: true },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;
  const sent = await page.request.post(`/v1/${path}:submit`, { headers: SPA_HEADERS });
  expect(sent.status(), await sent.text()).toBeLessThan(300);
  return path;
}
