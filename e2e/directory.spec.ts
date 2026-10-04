import { gotoRoute, test, expect } from "./fixtures";

// The people directory, and the profile behind a row.
//
// Two browser-only facts. The search narrows the list to one person out of a hundred - it is server-side, so
// it reaches past the first page, which is the whole reason it exists. And a row opens that person's profile
// at a URL that can be sent to somebody: `employees/<id>` and, with a tab on the end, the exact section - a
// deep link the notifications and the activity feed both produce.
test("the directory finds one person, and their profile deep-links to a section", async ({ as }) => {
  const page = await as("hr");

  await gotoRoute(page, "employees", "Directory");
  await page.getByRole("searchbox", { name: "Search people…" }).fill("Eve");
  const row = page.locator("tbody tr").filter({ hasText: "Eve Employee" });
  await expect(row).toHaveCount(1);
  await row.click();

  // The profile, at its own address - which is what makes it linkable.
  await expect(page.getByRole("heading", { level: 1, name: /Eve Employee/ })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/\/employees\/[a-z0-9]+/);
  const profileUrl = page.url();

  // The sections are tabs, and the open one rides in the URL: a link to somebody's Documents opens on their
  // Documents, not on their profile with instructions.
  await page.getByRole("tab", { name: "Documents" }).click();
  await expect.poll(() => page.url()).toContain("/documents");

  // And the link works from cold, in another browser: this is what a colleague receives.
  const colleague = await as("hr");
  await colleague.goto(`${page.url()}`);
  await expect(colleague.getByRole("main")).toBeVisible();
  await expect(colleague.getByRole("tab", { name: "Documents" })).toHaveAttribute("aria-selected", "true");

  expect(profileUrl).toContain("/employees/");
});

// `/` jumps to the list's search box, and the box says so: a shortcut nothing on screen names is one nobody finds.
test("the search box names the / key, and / puts the cursor in it", async ({ as }) => {
  const page = await as("hr");

  await gotoRoute(page, "employees", "Directory");
  const search = page.getByRole("searchbox", { name: "Search people…" });
  await expect(search).toHaveAttribute("placeholder", "Search (/) people…");
  await page.getByRole("main").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
});
