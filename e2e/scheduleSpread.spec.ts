import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// The roster dialog's OTHER mode: `schedule.spec.ts` assigns a single day at a time, but the same dialog can
// spread one shift across several days in one save (web/src/pages/Schedule.tsx's "Days" field + its
// "Working days" shortcut) - the button itself says which it is about to do ("Assign" vs "Assign N days"),
// and this half of that has never been exercised. One save has to become several real assignment rows, one
// per selected day, all landing on the SAME person's row.
test("spreading a shift across the working week from the roster dialog assigns every one of those days", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  await purgeShifts(page);
  await gotoRoute(page, "schedule", "Schedule");

  const shiftName = `E2E Spread Shift ${Date.now() % 100000}`;

  // `.last()`, not `.first()`: `schedule.spec.ts` picks its own empty cell the same way, off the same roster
  // grid, and "first empty cell" resolves to the identical cell for both when they run at once - whichever
  // saves second silently overwrites the other's assignment on it. Opposite ends of the same list is enough
  // to keep the two apart without either one needing to know about the other by name.
  const cell = page.getByRole("button", { name: /, no shift$/ }).last();
  await expect(cell).toBeVisible();
  const cellName = (await cell.getAttribute("aria-label")) ?? "";
  const person = cellName.split(",")[0]!;
  await cell.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Assign shift" })).toBeVisible();

  const addShift = dialog.getByRole("button", { name: "Add a shift" });
  if (await addShift.count()) await addShift.click();
  else await dialog.getByRole("button", { name: "New shift" }).click();
  await dialog.getByLabel("Shift name").fill(shiftName);
  await dialog.getByLabel("Start").fill("09:00");
  await dialog.getByLabel("End").fill("18:00");
  await dialog.getByRole("button", { name: "Add shift", exact: true }).click();

  const shifts = dialog.getByRole("radiogroup", { name: "Shift" });
  await expect(shifts.getByRole("radio", { name: new RegExp(shiftName) })).toHaveAttribute("aria-checked", "true");

  // The shortcut: every other working day this person has, added to the one already picked.
  const workingDays = dialog.getByRole("button", { name: "Working days" });
  await expect(workingDays).toBeVisible({ timeout: 15_000 });
  await workingDays.click();

  const assignBtn = dialog.getByRole("button", { name: /^Assign \d+ days$/ });
  const label = await assignBtn.textContent();
  const count = Number(label!.match(/\d+/)![0]);
  expect(count, "the shortcut should have picked up more than the one already-clicked day").toBeGreaterThan(1);

  await assignBtn.click();
  await expect(toast(page, `${count} days scheduled`)).toBeVisible({ timeout: 30_000 });

  // The gap between "one save" and "several rows": this same person now carries the shift on `count` cells,
  // not just the one that was clicked.
  const filled = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(person)}, .+, ${escapeRegExp(shiftName)}$`) });
  await expect(filled).toHaveCount(count, { timeout: 30_000 });

  await purgeShifts(page);
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    for (const s of results.filter((x) => (x.name ?? x.display_name ?? "").startsWith("E2E Spread Shift"))) await purge(page, s.path);
  }
}
