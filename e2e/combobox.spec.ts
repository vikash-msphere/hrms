import { gotoRoute, test, expect } from "./fixtures";

// The picker every form in the app is built out of.
//
// `ui/combobox.tsx` is one component behind a few hundred fields: a trigger, a search box that filters as it
// is typed, an active row the arrow keys move, and Enter to take it. All of that is keyboard and focus
// behaviour inside a portal - there is no module to unit-test that would prove the list filters, that Enter
// takes the row the highlight is on, or that leaving without choosing leaves the field as it was. And it is
// the one component where a regression is invisible in review and enormous in effect: every form that picks
// a person, a department, a category or a vendor goes through it.
//
// The label binding rides along, because it is the same component's business: Field mints an id and points
// its `<label for>` at the trigger, which is what makes `getByLabel` - and a screen reader - able to name
// the control at all.
test("the shared picker filters as you type, and Enter takes the highlighted row", async ({ as }) => {
  const page = await as("super");
  const person = await someEmployee(page);

  await gotoRoute(page, "documents", "Documents");
  await page.getByRole("button", { name: "Upload document" }).click();
  const dialog = page.getByRole("dialog");

  // Named by its label, not by a test id: the association is part of what is being asserted.
  const picker = dialog.getByLabel("Belongs to");
  await expect(picker).toHaveText("Organization");

  // Type a few letters and take the match with the keyboard alone.
  await picker.click();
  await dialog.getByPlaceholder("Search…").fill(person.first_name);
  await expect(dialog.getByRole("button", { name: person.name })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp"); // back to the top of the filtered list
  await page.keyboard.press("Enter");
  await expect(picker).toHaveText(person.name);

  // A search that matches nothing says so, rather than silently offering the unfiltered list.
  await picker.click();
  await dialog.getByPlaceholder("Search…").fill("zzzzz no such person");
  await expect(dialog.getByText("No matches.")).toBeVisible();

  // Leaving without choosing leaves the field exactly as it was.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveText(person.name);
});

/** A seeded employee, by the name the pickers show them under. */
async function someEmployee(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/employees?page_size=1");
  expect(res.status(), await res.text()).toBe(200);
  const first = ((await res.json()) as { results?: { first_name: string; last_name: string }[] }).results?.[0];
  if (!first) throw new Error("e2e: the org has no employees to pick");
  return { ...first, name: `${first.first_name} ${first.last_name}` };
}
