import { SPA_HEADERS, gotoRoute, inDays, purge, test, expect } from "./fixtures";

// Saying no to a week that was logged.
//
// `timesheetApproval` covers the yes: a submitted week reaching the manager's own page and being approved.
// The no is a different press with different consequences - the hours go back to the person who logged them,
// unbilled, and they have to re-file - so it asks first with the shared decision copy, and the entry then has
// to leave the queue rather than sit there looking undecided.
//
// `test/` owns the DRAFT → SUBMITTED → APPROVED/REJECTED machine. What only a browser shows is the pair of
// affordances on the queue row, the question, and the row settling afterwards.
test("a submitted entry is rejected from the manager's queue, and leaves it", async ({ as }) => {
  test.setTimeout(180_000);
  const employee = await as("employee");
  const manager = await as("manager");
  const admin = await as("super"); // the hard purge is an admin's to make
  const note = `E2E rejected hours ${Date.now() % 1_000_000}`;

  // An entry of this spec's own, submitted over the wire: filling the week grid is `timesheets`' subject.
  // The project has to exist before anybody can log against it, and creating one is an admin's write.
  //
  // Three weeks back, not three days: `timesheets` drives the SAME employee's CURRENT week in a browser, and
  // it reads the week total and the count in "Submitted N entries". An entry of this spec's landing in that
  // week makes both of those numbers somebody else's - which is a failure in `timesheets` whenever the two
  // run at once, and never when they run alone. `timesheetApproval` stays out of the way the same way.
  const project = await ensureProject(admin);
  const created = await employee.request.post("/v1/time-entries", {
    headers: SPA_HEADERS,
    data: { project, date: inDays(-17), hours: 3.5, description: note, billable: true },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;
  const submitted = await employee.request.post(`/v1/${path}:submit`, { headers: SPA_HEADERS });
  expect(submitted.status(), await submitted.text()).toBe(200);

  try {
    await gotoRoute(manager, "timesheets", "Timesheets");
    // The queue row for this entry, found by the note the logger typed, and scoped: the queue holds whatever
    // else the lane has submitted for this team, and the press below decides somebody's hours.
    const row = manager.locator("div.rounded-md.border").filter({ hasText: note }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Both answers are offered on the row; the destructive one is the quiet second.
    await expect(row.getByRole("button", { name: "Approve" })).toBeVisible();
    await row.getByRole("button", { name: "Reject" }).click();

    // Asked the way every decision in the app is asked, naming the hours and the day rather than "this row".
    const ask = manager.getByRole("dialog").filter({ hasText: "Reject this request?" });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask.getByText(/would have to file again/)).toBeVisible();
    await ask.getByRole("textbox", { name: "Reason", exact: true }).fill("Book these hours to the support project");
    await ask.getByRole("button", { name: "Reject", exact: true }).click();

    // Rejected on the server, and off the queue in the page: an entry that stays after the decision is how a
    // manager approves the same hours twice.
    await expect.poll(() => status(manager, path), { timeout: 30_000 }).toBe("REJECTED");
    await expect(manager.getByText(note)).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await purge(admin, path);
  }
});

/**
 * A project to log time against, brought by this spec.
 *
 * The seed ships none - timesheets are opt-in config, and `timesheets` makes its own too - so a spec that
 * assumed one would be testing a demo database rather than the app. Reused across runs by name, because a
 * project per run is a picker nobody can read by Friday.
 */
async function ensureProject(page: import("@playwright/test").Page): Promise<string> {
  const name = "E2E timesheet project";
  const list = await page.request.get("/v1/projects?page_size=100");
  expect(list.status(), await list.text()).toBe(200);
  const { results = [] } = (await list.json()) as { results?: { path: string; name?: string; delete_time?: string }[] };
  const found = results.find((p) => p.name === name && !p.delete_time);
  if (found) return found.path;
  const made = await page.request.post("/v1/projects", { headers: SPA_HEADERS, data: { name } });
  expect(made.status(), await made.text()).toBe(200);
  return ((await made.json()) as { path: string }).path;
}

/** The entry's status, as the server holds it. */
async function status(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { status?: string }).status?.toUpperCase();
}
