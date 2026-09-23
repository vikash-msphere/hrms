import { SPA_HEADERS, gotoRoute, makeThrowawayPerson, purge, retireThrowawayPerson, test, expect, toast } from "./fixtures";

// A week of time, logged in a grid and handed over.
//
// The timesheet is the app's other two-dimensional editor: projects down, days across, a cell per pair. Its
// rules only exist in the rendered grid - a cell knows its project AND its day, the quarter-hour steppers
// move the value people actually type, the week totals as it is filled, and submitting FREEZES the week so
// the cells stop being editable. That last one is the whole point of submitting, and it is invisible
// anywhere but here.
test("an employee logs time in the grid, the week totals it, and submitting freezes it", async ({ as }) => {
  const admin = await as("super");
  const hr = await as("hr");
  // A throwaway person, not the shared `employee` login: this asserts the WEEK TOTAL and the exact submitted
  // count, both of which sum every project for whoever is logged in - the seeded `employee` login is also
  // `timesheetCopyLastWeek.spec.ts`'s own actor, and the two can land an entry in each other's SAME real
  // calendar week within the same second under full concurrency, which no amount of before/after diffing
  // reliably tells apart from this spec's own entry. A fresh employee (role "employee" by default, same as the
  // seeded one - src/services/employees.ts) starts the week with nothing in it, which no sibling spec can touch.
  const person = await makeThrowawayPerson(admin, "Timesheet");
  const employee = await as({ email: person.email });

  // The org needs a project to log against; the page says so rather than offering an empty grid, and
  // creating one is Settings' business - so this spec brings its own through the API.
  const { path: project, name: projectName } = await makeProject(hr);

  try {
    await gotoRoute(employee, "timesheets", "Timesheets");

    // The grid holds the projects this person has already logged against, plus any they add - so a first-ever
    // entry starts by putting a project row on the grid.
    // `:visible`: the grid renders a desktop table AND a phone card list, so the control exists twice and only
    // one of them is on screen at this width.
    await employee.locator("button:visible").filter({ hasText: "Add project" }).first().click();
    await employee.getByRole("option", { name: projectName, exact: true }).click();

    // A cell names its project and its day, which is what makes "the right cell" a question with an answer -
    // so this spec asks for its OWN project's cells by name. `.first()` on the whole grid would otherwise be a
    // press on whichever project happens to sort first, but this fresh person has exactly one.
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
  } finally {
    await purge(hr, project);
    await retireThrowawayPerson(admin, person.path);
  }
});

/** A project to log against - the timesheet grid has nothing to draw without one. */
async function makeProject(page: import("@playwright/test").Page): Promise<{ path: string; name: string }> {
  const name = `E2E timesheets-project ${Date.now()}`;
  const res = await page.request.post("/v1/projects", { headers: SPA_HEADERS, data: { name, billable: true } });
  expect(res.status(), await res.text()).toBe(200);
  return { path: ((await res.json()) as { path: string }).path, name };
}
