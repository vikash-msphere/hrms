import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// A week of time, logged in a grid and handed over.
//
// The timesheet is the app's other two-dimensional editor: projects down, days across, a cell per pair. Its
// rules only exist in the rendered grid - a cell knows its project AND its day, the quarter-hour steppers
// move the value people actually type, the week totals as it is filled, and submitting FREEZES the week so
// the cells stop being editable. That last one is the whole point of submitting, and it is invisible
// anywhere but here.
test("an employee logs time in the grid, the week totals it, and submitting freezes it", async ({ as }) => {
  const employee = await as("employee");
  const hr = await as("hr");

  // The org needs a project to log against; the page says so rather than offering an empty grid, and
  // creating one is Settings' business - so this spec brings its own through the API. Leftovers from a run
  // that died are dropped first, or the picker fills up with them.
  //
  // The hours go through the EMPLOYEE's session and the projects through HR's, because that is who made each
  // of them: a spec that swept both as HR left the previous run's hours behind (an entry HR neither owns nor
  // can see), and this one then submitted a week holding two people's worth of them.
  await purgeEntries(employee);
  await purgeProjects(hr);
  const { path: project, name: projectName } = await makeProject(hr);

  await gotoRoute(employee, "timesheets", "Timesheets");

  // The grid holds the projects this person has already logged against, plus any they add - so a first-ever
  // entry starts by putting a project row on the grid.
  // `:visible`: the grid renders a desktop table AND a phone card list, so the control exists twice and only
  // one of them is on screen at this width.
  await employee.locator("button:visible").filter({ hasText: "Add project" }).first().click();
  await employee.getByRole("option", { name: projectName, exact: true }).click();

  // A cell names its project and its day, which is what makes "the right cell" a question with an answer -
  // so this spec asks for its OWN project's cells by name. The grid also carries every other project this
  // person has ever logged against (`timesheetReject` keeps one across runs), and `.first()` on the whole
  // grid is a press on whichever of those happens to sort first.
  const cell = (state: string) => employee.getByRole("button", { name: new RegExp(`^${projectName}, [\\d-]+, ${state}$`) });
  const empty = cell("no hours logged").first();
  await expect(empty).toBeVisible();
  await empty.click();

  const dialog = employee.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Log time" })).toBeVisible();
  await dialog.getByLabel("Hours").fill("6");
  // The steppers are the control people actually use for a quarter of an hour.
  await dialog.getByRole("button", { name: "Quarter hour more" }).click();
  await expect(dialog.getByLabel("Hours")).toHaveValue("6.25");
  await dialog.getByLabel(/Description/).fill(`E2E timesheet ${Date.now()}`);
  await dialog.getByRole("button", { name: /^(Log|Save)/ }).last().click();

  // The grid drew it, and the cell now says how long - the same button, renamed by its own contents.
  await expect(cell("6.25 hours").first()).toBeVisible();

  // The week totals what the grid holds, which is the number the submitter is committing to.
  await expect(employee.getByText(/Week total/)).toContainText("6.25");

  // Handing the week over freezes it: the cells that were editable stop being so. It asks first, because a
  // half-finished week submitted by accident has to be rejected before it can be fixed.
  await employee.getByRole("button", { name: /^Submit week/ }).click();
  const confirm = employee.getByRole("dialog");
  await expect(confirm.getByText("Submit for approval?")).toBeVisible();
  await confirm.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(toast(employee, /Submitted 1 entry/)).toBeVisible();
  await expect(cell("6.25 hours").first()).toBeDisabled();

  await purge(hr, project);
});

/** A project to log against - the timesheet grid has nothing to draw without one. */
async function makeProject(page: import("@playwright/test").Page): Promise<{ path: string; name: string }> {
  const name = `E2E project ${Date.now()}`;
  const res = await page.request.post("/v1/projects", { headers: SPA_HEADERS, data: { name, billable: true } });
  expect(res.status(), await res.text()).toBe(200);
  return { path: ((await res.json()) as { path: string }).path, name };
}

/** Drop the hours an earlier run of this spec logged - they still count towards the week it is about to total. */
async function purgeEntries(page: import("@playwright/test").Page) {
  const entries = await page.request.get("/v1/time-entries?page_size=100");
  if (!entries.ok()) return;
  const { results = [] } = (await entries.json()) as { results?: { path: string; description?: string }[] };
  for (const e of results.filter((x) => (x.description ?? "").startsWith("E2E timesheet"))) await purge(page, e.path);
}

/** Drop the projects that earlier runs of this spec left behind. */
async function purgeProjects(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/projects?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string; display_name?: string }[] };
  for (const p of results.filter((x) => (x.name ?? x.display_name ?? "").startsWith("E2E project"))) await purge(page, p.path);
}
