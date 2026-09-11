import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Deleting a draft offer outright - never pressed anywhere. `offers.spec.ts` walks draft → approved →
// extended and stops there; nothing removes one. Unlike most of this session's deletes, it raises no toast
// of its own (the handler just reloads the list) - so the row actually leaving is the only signal there is.
test("a draft offer is deleted from the list", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const stamp = Date.now();
  const candidate = `E2E Delete Offeree ${stamp}`;
  const role = `E2E Delete Offer Role ${stamp}`;

  const req = await create(page, "job-requisitions", { title: role, openings: 1 });
  const cand = await create(page, "candidates", { name: candidate, email: `e2e.offerdel.${stamp}@example.com` });
  const app = await create(page, "applications", { candidate: cand, requisition: req, stage: "offer" });
  const offerPath = await create(page, "offers", { application: app, base_comp: 1_200_000 });

  try {
    await gotoRoute(page, "offers", "Offers");
    const row = page.locator("tbody tr").filter({ hasText: candidate });
    await expect(row).toHaveCount(1, { timeout: 30_000 });

    // exact: the row's own candidate-name link is "E2E Delete Offeree ..." - a non-exact match on "Delete"
    // catches that too and Playwright refuses the ambiguous click.
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Delete this offer?" });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("tbody tr").filter({ hasText: candidate })).toHaveCount(0, { timeout: 30_000 });

    // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get` throws
    // notFound on `deleteTime` for every collection) - `show_deleted=true` on the list is the way to check.
    const after = await page.request.get(`/v1/offers?show_deleted=true&page_size=200`);
    expect(after.ok(), await after.text()).toBe(true);
    const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
    const found = results.find((r) => r.path === offerPath);
    expect(found?.delete_time, "the offer should survive soft-deleted, not be gone entirely").toBeTruthy();
  } finally {
    await purge(page, offerPath);
    await purgeMatching(page, "applications", (r) => (r.candidate ?? "") === cand);
    await purge(page, cand);
    await purge(page, req);
  }
});

async function create(page: import("@playwright/test").Page, collection: string, data: Record<string, unknown>): Promise<string> {
  const res = await page.request.post(`/v1/${collection}`, { headers: SPA_HEADERS, data });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

async function purgeMatching(page: import("@playwright/test").Page, collection: string, match: (row: Record<string, string>) => boolean) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) if (match(r)) await purge(page, r.path!);
}
