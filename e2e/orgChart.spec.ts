import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Reorganising the company by moving a box.
//
// The org chart is the one page in the app that is a management surface rather than a table: the tree it
// draws IS the edit affordance, and `test/reparenting.test.ts` (plus the collection lane's own PATCH tests)
// already owns what a re-parent does to the rows. What none of them can see is the part that only exists
// once the tree has been laid out - that the move control is reachable on the node it belongs to, that the
// picker refuses to offer a node its own descendant (the cycle guard is computed from the tree the browser
// built, not from anything the server said), that the subtree redraws around the new parent, and that a
// reload agrees with what the screen showed.
//
// Departments rather than people: a department move is the same `applyMove` path with the same picker, and
// two throwaway departments disturb nothing else in the seeded org (moving a seeded person would change
// whose queue their requests land in, for every spec that runs after this one).
test.describe("the org chart", () => {
  test("re-parents a department through the picker, and the tree agrees after a reload", async ({ as }) => {
    const page = await as("super");
    const stamp = Date.now();
    const parentName = `E2E parent dept ${stamp}`;
    const childName = `E2E child dept ${stamp}`;
    const parent = await makeDept(page, parentName);
    const child = await makeDept(page, childName);

    await openDepartmentOutline(page);

    // Both start at the top level, so neither is inside the other yet.
    await expect(row(page, parent)).toBeVisible();
    await expect(row(page, child)).toBeVisible();

    await row(page, child).getByTitle(/^Move/).click();
    const picker = page.getByRole("dialog");
    await expect(picker.getByRole("heading", { name: "Change parent department" })).toBeVisible();
    await picker.getByPlaceholder("Search…").fill(parentName);
    // A candidate button carries its secondary line too, so match on the name being IN it rather than being
    // the whole of it.
    await picker.getByRole("button", { name: new RegExp(parentName) }).click();

    // The picker moves without a second confirmation - it IS the confirmation - so the toast is the receipt.
    await expect(toast(page, "Reporting line updated")).toBeVisible();

    // "Under the parent" as the tree itself understands it: focusing the parent keeps the child on screen and
    // takes every other top-level department off it. Matched by prefix, like the move affordance above - the
    // rest of the title describes what a focus draws (the chain above the node as well as its subtree), which
    // is presentation and free to be reworded.
    await row(page, parent).getByTitle(/^Focus on this chain/).click();
    await expect(page.getByText("Focused:")).toBeVisible();
    await expect(row(page, child)).toBeVisible();

    // Written, not just re-rendered: a reload rebuilds the tree from the server's `parent` refs.
    await page.reload();
    await openDepartmentOutline(page, { alreadyLoaded: true });
    await row(page, parent).getByTitle(/^Focus on this chain/).click();
    await expect(row(page, child)).toBeVisible();

    await cleanUp(page, [child, parent]);
  });

  test("the picker will not offer a node its own descendant", async ({ as }) => {
    const page = await as("super");
    const stamp = Date.now();
    const parentName = `E2E cycle parent ${stamp}`;
    const childName = `E2E cycle child ${stamp}`;
    const parent = await makeDept(page, parentName);
    const child = await makeDept(page, childName, parent);

    await openDepartmentOutline(page);

    // Moving the parent under its own child would make a ring of the tree. The guard is a property of the
    // tree the browser assembled from what this caller may read, so nowhere else can check it.
    await row(page, parent).getByTitle(/^Move/).click();
    const picker = page.getByRole("dialog");
    await picker.getByPlaceholder("Search…").fill(childName);
    await expect(picker.getByText("No matches.")).toBeVisible();

    // And the escape hatch it does offer really is offered: "top level" is always a legal destination.
    await expect(picker.getByRole("button", { name: "Top level (no parent)" })).toBeVisible();
    await page.keyboard.press("Escape");

    await cleanUp(page, [child, parent]);
  });
});

type Page = import("@playwright/test").Page;

/** A department created straight through the API - this spec is about the tree, not about the create form. */
async function makeDept(page: Page, display_name: string, parent?: string): Promise<string> {
  const res = await page.request.post("/v1/departments", {
    headers: SPA_HEADERS,
    data: { display_name, ...(parent ? { parent } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** The outline layout's row for a department, found by the wire id the page stamps onto it. */
function row(page: Page, path: string) {
  return page.locator(`[data-org-id="${path.split("/")[1]}"]`);
}

// The chart opens on People in the tree layout. Departments is where a re-parent is safe to test, and the
// outline layout is the same nodes with the same controls in rows that do not depend on a canvas position.
async function openDepartmentOutline(page: Page, opts: { alreadyLoaded?: boolean } = {}) {
  if (!opts.alreadyLoaded) await gotoRoute(page, "org-chart", "Org Chart");
  else await expect(page.getByRole("main")).toBeVisible();
  // By its text, not its accessible name: the access-key button beside the toggle is labelled "Departments"
  // too, and it manages who may read them rather than switching the view.
  await page.locator('button:has-text("Departments")').click();
  await page.getByRole("button", { name: "Outline layout" }).click();
}

/** Take the throwaway departments back out, so a rerun starts where this one did. */
async function cleanUp(page: Page, paths: string[]) {
  for (const path of paths) await purge(page, path);
}
