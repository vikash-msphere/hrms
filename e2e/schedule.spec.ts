import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// The shift roster: a week-by-person grid you fill in by clicking cells.
//
// A roster is a two-dimensional editor, which is a shape no other test can reach: which cell belongs to whom
// on which day is a fact about the rendered grid, the shift patterns are created from inside the dialog that
// assigns them (an org with no shifts cannot roster anybody, so the first assignment has to be able to mint
// one), and the assignment has to survive a reload and be removable from the same cell. `test/shifts` owns
// the rows.
test("a shift is created from the roster and assigned to a day", async ({ as }) => {
  const page = await as("hr");
  // A run that died mid-way leaves shifts in the catalogue and an assignment on the cell it was using, which
  // would send this one down the "edit" branch instead of the "assign" one.
  await purgeShifts(page);
  await gotoRoute(page, "schedule", "Schedule");

  const shiftName = `E2E Shift ${Date.now() % 100000}`;

  // An EMPTY cell, named after the person and day it belongs to - so the assignment cannot land on the wrong
  // row, and the dialog is the one that assigns rather than the one that edits.
  const cell = page.getByRole("button", { name: /, no shift$/ }).first();
  await expect(cell).toBeVisible();
  const cellName = (await cell.getAttribute("aria-label")) ?? "";
  const person = cellName.split(",")[0]!;
  const day = cellName.split(", ")[1]!;
  await cell.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Assign shift" })).toBeVisible();

  // No shifts configured yet: the dialog mints one rather than sending the reader to Settings and back.
  const addShift = dialog.getByRole("button", { name: "Add a shift" });
  if (await addShift.count()) await addShift.click();
  else await dialog.getByRole("button", { name: "New shift" }).click();
  await dialog.getByLabel("Shift name").fill(shiftName);
  await dialog.getByLabel("Start").fill("09:00");
  await dialog.getByLabel("End").fill("18:00");
  await dialog.getByRole("button", { name: "Add shift", exact: true }).click();

  // The new shift is the one selected, in the radiogroup that offers them.
  const shifts = dialog.getByRole("radiogroup", { name: "Shift" });
  await expect(shifts.getByRole("radio", { name: new RegExp(shiftName) })).toHaveAttribute("aria-checked", "true");

  // "Assign" or "Assign N days": one dialog can spread the same shift across the week, and the button says
  // which it is about to do.
  await dialog.getByRole("button", { name: /^Assign/ }).click();
  await expect(toast(page, /Shift assigned|days scheduled/)).toBeVisible();

  // The grid drew it: the cell that was empty now names the shift it carries.
  const filled = page.getByRole("button", { name: `${person}, ${day}, ${shiftName}` });
  await expect(filled).toBeVisible();

  // And it survives a reload, so it is a row rather than a rendering.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(filled).toBeVisible();

  // Taking it off again is the same cell, so the roster is corrected where it is read - and it asks first,
  // because the gap it leaves is what everybody else reads off the roster.
  await filled.click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Remove this shift?")).toBeVisible();
  await confirm.getByRole("button", { name: "Remove shift" }).click();
  // The gap in the grid is the receipt - a toast lives five seconds, the roster is what everybody reads.
  await expect(page.getByRole("button", { name: `${person}, ${day}, no shift` })).toBeVisible();

  await purgeShifts(page);
});

/** Drop every shift this spec has ever created, and any assignment hanging off it. */
async function purgeShifts(page: import("@playwright/test").Page) {
  const assignments = await page.request.get("/v1/shift-assignments?page_size=100");
  if (assignments.ok()) {
    const { results = [] } = (await assignments.json()) as { results?: { path: string; shift?: string }[] };
    for (const a of results) await purge(page, a.path);
  }
  const shifts = await page.request.get("/v1/shifts?page_size=100");
  if (shifts.ok()) {
    const { results = [] } = (await shifts.json()) as { results?: { path: string; name?: string; display_name?: string }[] };
    for (const s of results.filter((x) => (x.name ?? x.display_name ?? "").startsWith("E2E Shift"))) await purge(page, s.path);
  }
}
