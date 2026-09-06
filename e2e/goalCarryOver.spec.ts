import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The goal that did not get finished, moved on rather than left to rot.
//
// A quarter ends with goals still open, and the honest thing to do with one is carry it: a fresh goal for the
// new quarter carrying the title, weight and progress across, and the old one closed as cancelled so the
// finished quarter reads as what actually happened. Both halves are done by the browser - it composes the
// copy and then patches the original - so a break here leaves either two live goals saying the same thing or
// an old goal quietly cancelled with no successor.
//
// `goals` covers progress and `goalAlignment` the tree. `test/goalAlignment.test.ts` owns the rollup. Nothing
// covers the carry, and it is offered only on a goal old enough to need it, which is why this one brings a
// goal with a due date in a quarter that has been and gone.
test("an overdue goal is carried into the next quarter, and the original closes", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("manager");
  const admin = await as("super"); // the hard purge is an admin's to make
  const title = `E2E carried goal ${Date.now() % 1_000_000}`;

  // Due six months ago: comfortably before the start of the current quarter, which is what makes it carryable
  // whenever in the year this spec happens to run.
  const dueLastQuarter = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
  const created = await page.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { title, description: "Raised by the carry-over spec.", due_date: dueLastQuarter },
  });
  expect(created.status(), await created.text()).toBe(200);
  const original = ((await created.json()) as { path: string }).path;

  try {
    // Opened by its own deep link - the carry is offered on the goal itself, not only on the overdue banner.
    await gotoRoute(page, `goals/${original.split("/")[1]}`);
    const detail = page.getByRole("dialog");
    await expect(detail.getByText(title).first()).toBeVisible({ timeout: 30_000 });

    await detail.getByRole("button", { name: "Carry to next quarter" }).click();

    // Two writes, one press: the copy exists with a due date in the future...
    await expect.poll(() => copies(page, title), { timeout: 30_000 }).toHaveLength(2);
    const [copy] = (await copies(page, title)).filter((g) => g.path !== original);
    expect(copy, "the carried copy was not created").toBeTruthy();
    expect((copy!.due_date ?? "") > dueLastQuarter, `the copy is still due ${copy!.due_date}`).toBe(true);

    // ...and the original is closed, so the quarter that ended reads as what actually happened.
    await expect.poll(async () => (await copies(page, title)).find((g) => g.path === original)?.status, { timeout: 30_000 })
      .toBe("cancelled");
  } finally {
    for (const g of await copies(page, title)) await purge(admin, g.path);
  }
});

/** Every goal carrying this title - the original and, once it has been carried, its copy. */
async function copies(
  page: import("@playwright/test").Page,
  title: string,
): Promise<{ path: string; due_date?: string; status?: string }[]> {
  const res = await page.request.get("/v1/goals?page_size=200");
  if (!res.ok()) return [];
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; due_date?: string; status?: string }[] };
  return results.filter((g) => g.title === title);
}
