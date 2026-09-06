import { SPA_HEADERS, gotoRoute, personId, test, expect } from "./fixtures";

// A promotion, recorded as history rather than as an overwrite.
//
// A role change is a new effective-dated row: the row it supersedes is closed on that date, and the person's
// live designation and department are synced to match. It needs a browser for the reason the compensation
// timeline does: the form's whole job is to say what the change MOVES, computed in the page against the row
// it is about to supersede ("Engineer → Senior Engineer"), and to refuse a date that would put the history
// out of order. Neither exists anywhere but the rendered dialog. Then the table behind it has to read back as
// a history, with exactly one row current.
//
// Nothing is cleaned up afterwards, because `positions` has no DELETE at all (src/routes/positions.ts): a
// role change supersedes, it never edits or removes what was true before. So this spec is written to run on
// top of whatever it finds - it dates its change AFTER the current row rather than assuming a date - and it
// puts the person's designation back by recording it again, which is the only way back there is.
test("a role change states what it moves, refuses a backdate, and closes the previous role", async ({ as }) => {
  test.setTimeout(180_000);
  // HR + super only, and this is HR's own record-keeping surface.
  const hr = await as("hr");
  const employee = `employees/${await personId(hr, "employee")}`;
  const stamp = Date.now();
  const title = `E2E Senior Engineer ${stamp % 100000}`;

  // What the record started as, taken from the OLDEST row rather than the current one: a run that died half
  // way leaves its own title as the live designation, and this spec must not then "restore" that.
  const history = await positions(hr, employee);
  const original = history[history.length - 1]?.job_title;
  const current = history.find((p) => p.current);

  await gotoRoute(hr, employee);
  await hr.getByRole("tab", { name: "Employment" }).click();
  await expect(hr.getByText("Role history").first()).toBeVisible({ timeout: 30_000 });
  // The card's own read has to have landed before the dialog is opened: the form is seeded from the row it
  // would supersede, and a dialog opened over the skeleton seeds itself from nothing.
  await expect(
    hr.locator("tbody tr").first().or(hr.getByText("No role history on record.", { exact: false })),
  ).toBeVisible({ timeout: 30_000 });

  await hr.getByRole("button", { name: "Change role" }).click();
  const form = hr.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Change role" })).toBeVisible();

  // Opened on the current role's values, and therefore proposing nothing yet: it says so rather than
  // recording a "change" in which nothing changed.
  if (current) {
    await expect(form.getByText("Nothing changes yet - edit a field above to record a move.")).toBeVisible();
    await expect(form.getByRole("button", { name: "Save change" })).toBeDisabled();
  }

  // The delta, against the row this would supersede: a promotion dialog that showed only the new designation
  // would leave the reader to remember the old one.
  const designation = form.getByLabel("Designation");
  const wasTitle = (await designation.inputValue()) || "-";
  await designation.fill(title);
  if (current) {
    await expect(form.getByText(wasTitle, { exact: true }).first()).toBeVisible();
    await expect(form.getByText(title, { exact: true }).first()).toBeVisible();

    // A date on or before the current role's start would read out of order, and "current" would then be
    // decided by the wrong row - blocked on the field rather than warned about after the fact.
    await form.getByLabel("Effective from").fill(current.effective_from);
    await expect(form.getByText(/must be after the current role's start/i).first()).toBeVisible();
    await expect(form.getByRole("button", { name: "Save change" })).toBeDisabled();
  }

  // The day after whatever the history already reaches, so this is always a move forward - the row this
  // supersedes may itself have been dated in the future by an earlier run of this spec.
  const effective = dayAfter(current?.effective_from);
  await form.getByLabel("Effective from").fill(effective);
  await form.getByLabel("Note (optional)").fill("Promotion (e2e)");
  await expect(form.getByRole("button", { name: "Save change" })).toBeEnabled();
  await form.getByRole("button", { name: "Save change" }).click();
  await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The history, read back: the new row is on it, dated, and it is the ONE row claiming to be current. Two
  // current rows is the failure this shape exists to prevent.
  const row = hr.locator("tr").filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(effective);
  await expect(row).toContainText("current");
  await expect(hr.locator("tr").filter({ hasText: "current" })).toHaveCount(1);

  // And the person's live designation followed the change - the reason this is recorded here rather than
  // typed into the record by hand.
  await hr.reload();
  await expect(hr.getByText(title).first()).toBeVisible({ timeout: 30_000 });

  // Put the designation back by recording it again (the only way back: the history is append-only), so the
  // directory, the org chart and every letter read what they did before this spec ran.
  if (original) await recordPosition(hr, employee, original, dayAfter(effective));
});

/** The day after `ymd`, or tomorrow when there is nothing to come after. */
function dayAfter(ymd?: string): string {
  const from = ymd ? Date.parse(`${ymd}T00:00:00Z`) : Date.now();
  const next = new Date(Math.max(from, Date.now()) + 86_400_000);
  return next.toISOString().slice(0, 10);
}

/** This person's role history, newest first - the same read the card makes. */
async function positions(
  page: import("@playwright/test").Page,
  employee: string,
): Promise<{ path: string; effective_from: string; job_title?: string; current?: boolean }[]> {
  const res = await page.request.get(`/v1/positions?employee=${encodeURIComponent(employee)}&page_size=100`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { results?: { path: string; effective_from: string; job_title?: string; current?: boolean }[] }).results ?? [];
}

/** Record a role over the wire - used only to put the record back. */
async function recordPosition(
  page: import("@playwright/test").Page,
  employee: string,
  jobTitle: string,
  effective: string,
): Promise<void> {
  const res = await page.request.post("/v1/positions", {
    headers: SPA_HEADERS,
    data: { employee, job_title: jobTitle, effective_from: effective },
  });
  expect(res.status(), await res.text()).toBe(200);
}
