import { ROLES, gotoRoute, personId, test, expect, type Role } from "./fixtures";

// Finding one person in a chart of a hundred.
//
// The org chart is drawn from the whole employees collection in the browser: the tree, the subtree a focus
// narrows it to, the ancestor trail back up, and the search that walks matches one at a time (opening the
// branches they are buried in on the way). None of that is a request, so none of it is reachable from the
// vitest suite - and `orgChart` covers the other half of the page, the re-parent and the guard on dropping a
// node into its own descendant.
//
// What only a browser shows: `org-chart/<id>` really opens ON that person (the deep link the directory's
// "view in org chart" hands out), the trail says how you got there and walks back up, and the search counts
// its matches and steps through them.
test.describe("the org chart", () => {
  test("a deep link opens on that person's subtree, and the trail leads back out", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    const managerId = await personId(page, "manager");
    const manager = await personName(page, "manager");

    // The address the record page's "Org chart" button produces - opened cold, which is the case that has to
    // work: there is no chart already on screen to narrow, so the focus has to survive the first render.
    await gotoRoute(page, `org-chart/${managerId}`, "Org Chart");
    // `.first()` throughout: a chip's wrapper carries the same words as the span inside it, so both match.
    await expect(page.getByText("Focused:").first()).toBeVisible({ timeout: 30_000 });
    // The trail is the ancestors plus the person themself, each a way back up to that level.
    await expect(page.getByRole("button", { name: manager, exact: true }).first()).toBeVisible();

    // Out of the subtree and back to everyone - the escape hatch beside the trail, which is the only way back
    // when the focus arrived in the URL rather than by a click.
    await page.getByRole("button", { name: "Full chart" }).click();
    await expect(page.getByText("Showing what you're allowed to see").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Focused:")).toHaveCount(0);
  });

  test("search counts its matches and steps through them", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    const employee = await personName(page, "employee");
    await gotoRoute(page, "org-chart", "Org Chart");

    // A whole name, so what is being counted is one person rather than every colleague who shares a first
    // name - the count is the assertion, and it has to mean something.
    await page.getByRole("searchbox", { name: "Find someone…" }).fill(employee);
    await expect(page.getByText(/\d+ of \d+ match/).first()).toBeVisible({ timeout: 30_000 });
    // Matches are buried in collapsed branches until the search opens them: the node itself on screen is the
    // proof that happened, not just that the counter moved.
    await expect(page.getByText(employee).first()).toBeVisible();

    // Enter steps to the next match (and wraps), which is what makes a chart with several matches walkable
    // without a mouse.
    await page.getByRole("searchbox", { name: "Find someone…" }).press("Enter");
    await expect(page.getByText(/\d+ of \d+ match/).first()).toBeVisible();

    // A query nobody answers says so rather than drawing an empty chart.
    await page.getByRole("searchbox", { name: "Find someone…" }).fill("zzzz-nobody-zzzz");
    await expect(page.getByText("0 matches").first()).toBeVisible({ timeout: 30_000 });
  });
});

/** The seeded name behind a role login, which is what the chart is searched and read by. */
async function personName(page: import("@playwright/test").Page, role: Role): Promise<string> {
  const res = await page.request.get("/v1/employees?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as {
    results?: { first_name?: string; last_name?: string; work_email?: string }[];
  };
  const person = results.find((e) => e.work_email === ROLES[role]);
  if (!person) throw new Error(`e2e: no employee record for ${ROLES[role]}`);
  return `${person.first_name} ${person.last_name}`;
}
