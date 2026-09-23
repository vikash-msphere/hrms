import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting an org document - `documentLockToggle.spec.ts` proves Delete disappears from a locked document's
// menu, but never actually presses it on an unlocked one, and none of the other document specs (upload,
// enable, publish, remind, ack) do either. Shares the generic `useSoftDelete` mechanism `undo.spec.ts` proves
// once (on vendors); this is this page's own copy, for `org-documents` specifically (`personal-documents`
// carries a second, separate `useSoftDelete` instance the same page also owns).
test("an org document is deleted from the list", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const title = `E2E delete document ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/org-documents", {
    headers: SPA_HEADERS,
    data: { display_name: title, document_type: "POLICY" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  await gotoRoute(page, "documents", "Documents");
  const row = page.locator("tbody tr").filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Document deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("tbody tr").filter({ hasText: title })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (every `get` in documentService.ts throws notFound on
  // `deleteTime` - the same 404-on-deleted convention as everywhere else) - `show_deleted=true` on the list is
  // the actual way to prove the row survived.
  const after = await page.request.get(`/v1/org-documents?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((d) => d.path === path);
  expect(found?.delete_time, "the document should survive soft-deleted, not be gone entirely").toBeTruthy();
});
