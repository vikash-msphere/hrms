import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// An org document's own publish/unpublish - `useLifecycle`'s generic verb pair, wired into the row menu
// (Documents.tsx), never exercised by any spec: every other Documents spec either doesn't touch `published`
// at all or sets it once over the wire at create time. The menu item itself is the only visible state (there
// is no separate "Draft" badge), so what this proves is that pressing it actually flips the field the
// document was created with, both ways.
test("a document is published, then unpublished, from its own row menu", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const title = `E2E publish toggle ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/org-documents", {
    headers: SPA_HEADERS,
    data: { display_name: title, document_type: "POLICY", published: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  const doc = (await made.json()) as { path: string; published?: boolean };
  expect(doc.published).toBe(false);

  try {
    await gotoRoute(page, "documents", "Documents");
    const row = page.locator("tbody tr").filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Publish", exact: true }).click();
    await expect(toast(page, "Document published")).toBeVisible({ timeout: 30_000 });

    const publishedRow = await reread(page, title);
    expect(publishedRow.published).toBe(true);

    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Unpublish", exact: true }).click();
    await expect(toast(page, "Document unpublished")).toBeVisible({ timeout: 30_000 });

    const unpublishedRow = await reread(page, title);
    expect(unpublishedRow.published).toBe(false);
  } finally {
    await purge(page, doc.path);
  }
});

async function reread(page: import("@playwright/test").Page, title: string): Promise<{ published?: boolean }> {
  const res = await page.request.get("/v1/org-documents?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { display_name?: string; published?: boolean }[] };
  const found = results.find((d) => d.display_name === title);
  if (!found) throw new Error(`e2e: no org-document on file titled ${title}`);
  return found;
}
