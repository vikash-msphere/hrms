import { apiPost, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Locking an org document (the other half of Documents.tsx's row menu never exercised before this run's
// `documentPublishToggle.spec.ts`) - and unlike publish/unpublish, locking has a real, visible effect on the
// menu itself: while locked, every other action (Edit details, Replace file, Publish/Unpublish,
// Enable/Disable, Delete) disappears, leaving only Unlock. A document a writer cannot even ask to edit is
// what "locked" is supposed to mean, and nothing has ever proven the menu actually collapses that far.
test("locking a document collapses its menu to Unlock alone, and unlocking restores it", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const title = `E2E lock toggle ${Date.now() % 1_000_000}`;

  // `apiPost`, not a bare request: this is the spec's SCAFFOLDING, and the runtime answers whatever is in
  // flight with "Your worker restarted mid-request" when wrangler recycles the Worker under the lane. Nothing
  // re-sends a POST, so the document was never created and the spec died before reaching its claim.
  const made = await apiPost(page, "org-documents", { display_name: title, document_type: "POLICY" });
  expect(made.status(), await made.text()).toBe(200);
  const doc = (await made.json()) as { path: string };

  try {
    await gotoRoute(page, "documents", "Documents");
    const row = page.locator("tbody tr").filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Edit details" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Unpublish", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Lock", exact: true }).click();
    await expect(toast(page, "Document locked")).toBeVisible({ timeout: 30_000 });

    // Collapsed: the only thing a locked document offers is the way back out. Activity stays - it changes
    // nothing about the document, and "who locked this, and when" is exactly what a locked row is asked.
    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Unlock", exact: true })).toBeVisible();
    for (const gone of ["Edit details", "Replace file", "Publish", "Unpublish", "Disable", "Enable", "Delete"]) {
      await expect(page.getByRole("menuitem", { name: gone, exact: true })).toHaveCount(0);
    }

    const locked = await reread(page, title);
    expect(locked.locked).toBe(true);

    await page.getByRole("menuitem", { name: "Unlock", exact: true }).click();
    await expect(toast(page, "Document unlocked")).toBeVisible({ timeout: 30_000 });

    // Restored: the rest of the menu is back.
    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Edit details" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Unpublish", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    const unlocked = await reread(page, title);
    expect(unlocked.locked).toBe(false);
  } finally {
    await purge(page, doc.path);
  }
});

async function reread(page: import("@playwright/test").Page, title: string): Promise<{ locked?: boolean }> {
  const res = await page.request.get("/v1/org-documents?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { display_name?: string; locked?: boolean }[] };
  const found = results.find((d) => d.display_name === title);
  if (!found) throw new Error(`e2e: no org-document on file titled ${title}`);
  return found;
}
