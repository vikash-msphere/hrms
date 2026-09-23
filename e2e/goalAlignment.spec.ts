import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The picker that refuses to make a loop.
//
// Goals align to other goals, which makes them a tree - and a tree in a form is one wrong option away from a
// cycle: a goal aligned under its own child rolls its progress up into itself. The server rejects a cycle,
// but the reason it never gets asked one is a guard computed in the BROWSER, from the tree the page has
// already built: the alignment picker offers no goal that is the one being edited or anything beneath it.
//
// `test/goalAlignment.test.ts` owns the rollup arithmetic and the server's refusal. `goals` covers the
// progress control. Nothing anywhere covers the picker - and a guard that quietly stops excluding is
// invisible until somebody files a support ticket about a goal at 4000%.
test("the alignment picker will not offer a goal its own descendant", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("manager");
  const admin = await as("super"); // the hard purge is an admin's to make
  const stamp = Date.now() % 1_000_000;
  const parentTitle = `E2E parent goal ${stamp}`;
  const childTitle = `E2E child goal ${stamp}`;

  // The two goals are written over the wire: the composer is `goals`' subject, and what this spec is about
  // starts once a parent and a child exist.
  const parent = await makeGoal(page, { title: parentTitle });
  const child = await makeGoal(page, { title: childTitle, parent });
  // A THIRD GOAL THIS PAIR IS NOT RELATED TO, so the picker exists at all. The field is drawn only when there
  // is something in it to pick (web/src/pages/Goals.tsx), and editing the parent excludes the parent and
  // everything under it - so on a page holding only this spec's two goals there is nothing left to offer and
  // no "Aligns to" to press. It passed anyway whenever another spec's goals happened to be visible to this
  // manager at the same moment, which is a spec that is only as sound as its neighbours are busy.
  const spare = await makeGoal(page, { title: `E2E spare goal ${stamp}` });

  try {
    await gotoRoute(page, "goals", "Goals");
    await expect(page.getByText(parentTitle).first()).toBeVisible({ timeout: 30_000 });

    // Editing the PARENT: its own child is beneath it in the tree, so aligning the parent under it would be
    // a loop - and the picker is where that has to be prevented, because by the time the server refuses, the
    // person has already been offered the thing they wanted.
    await openEdit(page, parentTitle);
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Edit goal" })).toBeVisible();
    await form.getByLabel("Aligns to").click();
    // Searched for by name rather than eyeballed down a list: the picker filters, and the assertion has to be
    // "this goal is not offered", not "it wasn't in the first ten rows".
    await form.getByPlaceholder("Search goals…").fill(childTitle);
    await expect(form.getByRole("option", { name: childTitle })).toHaveCount(0);
    // The goal itself is excluded for the same reason, and by the same rule.
    await form.getByPlaceholder("Search goals…").fill(parentTitle);
    await expect(form.getByRole("option", { name: parentTitle })).toHaveCount(0);
    // Out of the picker, then out of the dialog. The second step is the dialog's own Cancel rather than a
    // second Escape: the two presses land in the same frame, the popover is still unmounting when the second
    // arrives, and the dialog under it never sees it - which leaves this spec waiting on a dialog that is
    // simply still open.
    await page.keyboard.press("Escape");
    await expect(form.getByPlaceholder("Search goals…")).toHaveCount(0, { timeout: 30_000 });
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // The other direction is legal and has to stay offered: a child may align under a goal above it, which is
    // what proves the exclusion above is the guard talking rather than an empty picker.
    await openEdit(page, childTitle);
    const childForm = page.getByRole("dialog");
    await expect(childForm.getByRole("heading", { name: "Edit goal" })).toBeVisible();
    await childForm.getByLabel("Aligns to").click();
    await childForm.getByPlaceholder("Search goals…").fill(parentTitle);
    await expect(childForm.getByRole("option", { name: parentTitle })).toBeVisible({ timeout: 30_000 });
  } finally {
    await purge(admin, child);
    await purge(admin, parent);
    await purge(admin, spare);
  }
});

/** A goal owned by the caller. Returns its wire path. */
async function makeGoal(page: import("@playwright/test").Page, data: { title: string; parent?: string }): Promise<string> {
  const res = await page.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { ...data, description: "Raised by the alignment spec." },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** Open the edit dialog of the goal card carrying `title`. */
async function openEdit(page: import("@playwright/test").Page, title: string) {
  const card = page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.hover();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
}
