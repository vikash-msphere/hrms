import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The last untested pair in Documents.tsx's row-menu lifecycle cluster: Enable/Disable (`documentPublishToggle`
// and `documentLockToggle` cover publish/unpublish and lock/unlock). Like publish/unpublish, there is no
// separate badge for a disabled document - the menu item itself is the only visible state - so this proves
// pressing it actually flips the field the document was created with, both ways.
test("a document is disabled, then enabled, from its own row menu", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const title = `E2E enable toggle ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/org-documents", {
    headers: SPA_HEADERS,
    data: { display_name: title, document_type: "POLICY" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const doc = (await made.json()) as { path: string; disabled?: boolean };
  expect(doc.disabled ?? false).toBe(false);

  try {
    await gotoRoute(page, "documents", "Documents");
    const row = page.locator("tbody tr").filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
    await expect(toast(page, "Document disabled")).toBeVisible({ timeout: 30_000 });

    const disabledRow = await reread(page, title);
    expect(disabledRow.disabled).toBe(true);

    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Enable", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Enable", exact: true }).click();
    await expect(toast(page, "Document enabled")).toBeVisible({ timeout: 30_000 });

    const enabledRow = await reread(page, title);
    expect(enabledRow.disabled ?? false).toBe(false);
  } finally {
    await purge(page, doc.path);
  }
});

async function reread(page: import("@playwright/test").Page, title: string): Promise<{ disabled?: boolean }> {
  const res = await page.request.get("/v1/org-documents?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { display_name?: string; disabled?: boolean }[] };
  const found = results.find((d) => d.display_name === title);
  if (!found) throw new Error(`e2e: no org-document on file titled ${title}`);
  return found;
}
