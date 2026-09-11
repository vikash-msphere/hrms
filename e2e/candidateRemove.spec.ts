import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Removing a candidate from the pipeline's own front door.
//
// `ats.spec.ts` and the interview/offer specs build candidates UP through the pipeline; none of them ever
// takes one back out. The row's own "Remove" is a plain soft-delete (no cascade to declare - an application
// still references the candidate by id, and a soft-deleted row keeps that FK intact), but nothing has ever
// pressed it or proven the confirm behind it.
test("a candidate with no application is removed from the list", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const name = `E2E Remove Candidate ${Date.now() % 100000}`;

  const made = await page.request.post("/v1/candidates", { headers: SPA_HEADERS, data: { name } });
  expect(made.status(), await made.text()).toBe(200);
  const candidate = (await made.json()) as { path: string };

  try {
    await gotoRoute(page, "candidates", "Candidates");
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // exact: the row's own name link is "E2E Remove Candidate ..." - a non-exact match on "Remove" catches
    // that too and Playwright refuses the ambiguous click.
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Remove this candidate?")).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // Off the ordinary list...
    await expect(page.locator("tbody tr").filter({ hasText: name })).toHaveCount(0, { timeout: 30_000 });

    // ...but soft-deleted, not erased. Plain GET 404s on a deleted row by design (the generic crud factory's
    // default `get` throws notFound on `deleteTime`), so `show_deleted=true` on the list is the way to check.
    const after = await page.request.get(`/v1/candidates?show_deleted=true&page_size=200`);
    expect(after.ok(), await after.text()).toBe(true);
    const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
    const found = results.find((r) => r.path === candidate.path);
    expect(found?.delete_time, "the candidate should survive soft-deleted, not be gone entirely").toBeTruthy();
  } finally {
    await purge(page, candidate.path);
  }
});
