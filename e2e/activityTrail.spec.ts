import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The audit trail, as a person reads it.
//
// The server suite owns what gets written (`auditAccess`, the audit-meta tests) and `requestBudget` owns the
// rule that the trail is not read until the disclosure is opened. What is left, and what only a browser can
// show, is the rendering: the feed turns an audit row's `meta` into "field: old → new" chips, and it does it
// from a value diff the server had to have recorded. A change made through the form beside it is therefore
// the honest test of the whole chain - form writes, server audits with a diff, feed renders the diff - and a
// break anywhere in it shows up as a trail that lists the change but cannot say what changed.
test("a record's trail shows what the form beside it just changed", async ({ as }) => {
  const page = await as("super");
  const before = `E2E audited vendor ${Date.now()}`;
  const after = `${before} renamed`;

  const created = await page.request.post("/v1/vendors", { headers: SPA_HEADERS, data: { display_name: before } });
  expect(created.status(), await created.text()).toBe(200);
  const vendor = (await created.json()) as { path: string };

  // Reads travel inside `/v1/batch:run` bodies as often as they travel on their own, so both are watched.
  const reads: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/v1/activity") reads.push(u.search);
    if (u.pathname === "/v1/batch:run") {
      for (const m of (r.postData() ?? "").matchAll(/\/v1\/activity\?[^"]*/g)) reads.push(m[0]);
    }
  });

  await gotoRoute(page, "vendors", "Vendors");

  // Rename it through the form, the way the change under audit would really be made.
  const row = page.locator("tbody tr").filter({ hasText: before });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(after);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: after })).toHaveCount(1);

  // Back into the record, and ask for its history.
  await page.locator("tbody tr").filter({ hasText: after }).getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const trail = page.getByRole("dialog").getByRole("button", { name: "Activity" });
  await expect(trail).toHaveAttribute("aria-expanded", "false");
  await trail.click();

  // It reads THIS record's trail, not the whole org's.
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(reads[0]).toContain(`resource=${encodeURIComponent(vendor.path)}`);

  // Both halves of what the record has been through, in the log's own order.
  const entries = page.getByRole("dialog").locator("tbody tr");
  await expect(entries.filter({ hasText: "updated" })).not.toHaveCount(0);
  await expect(entries.filter({ hasText: "created" })).not.toHaveCount(0);

  // And the change itself, spelled out: the old value, an arrow, the new one. A diff the server never
  // recorded renders as a bare "updated" with nothing under it, which is the failure worth catching.
  const change = entries.filter({ hasText: "updated" }).first();
  await expect(change).toContainText(before);
  await expect(change).toContainText(after);

  await page.keyboard.press("Escape");
  await purge(page, vendor.path);
});
