import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The org-wide audit trail, as an admin reads it.
//
// `activityTrail` covers one record's history inside a dialog. This is the whole-workspace feed: the page
// that answers "who did that, and when". Three things about it only exist in the browser - the
// "Permission changes" door (the same feed with its object-type filter pre-set, because access-rule writes
// are the question this feed gets asked most and are otherwise buried), the search that reaches the trail
// by person, record or action, and the tone filter that separates a change from a blocked attempt.
test("the activity page finds a change, and the permissions view narrows to access writes", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");

  // Something to find: a vendor created through the API, which the audit trail records like any write.
  const name = `E2E audited ${Date.now()}`;
  const created = await page.request.post("/v1/vendors", { headers: SPA_HEADERS, data: { display_name: name } });
  expect(created.status(), await created.text()).toBe(200);
  const vendor = (await created.json()) as { path: string };

  await gotoRoute(page, "activity", "Activity");

  // The feed is search-first: the trail is thousands of rows, so finding the one you mean is the feature.
  const search = page.getByPlaceholder(/Search action, person or record/);
  await search.fill(name);
  await search.press("Enter");
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: "created" }).first()).toBeVisible();

  // The permission-changes door: the same feed, pre-filtered to access-rule writes. It is a different
  // question ("who widened access?") and it gets its own press rather than four filter changes.
  await page.getByRole("button", { name: "Permission changes" }).click();
  await expect(page.getByRole("button", { name: "Permission changes" })).toBeVisible();
  // Pre-set, not merely available: the vendor write above must NOT be in this view.
  await expect(page.locator("tbody tr").filter({ hasText: name })).toHaveCount(0);

  // And back to everything, which is the same feed with the filter cleared.
  await page.getByRole("button", { name: "Everything" }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await purge(page, vendor.path);
});
