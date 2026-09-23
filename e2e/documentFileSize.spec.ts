import { allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The exact string `formatBytes` (lib/utils.ts) puts on a document row - "50 KB", not "51200 bytes" and not
// "0.05 MB". `documentUpload.spec.ts` proves an upload's bytes round-trip; this pins the one formatter that
// turns that byte count into what a reader actually reads, at a size chosen so the rounding it does (KB to
// zero decimals) has exactly one right answer to land on.
test("an uploaded file's size reads as a rounded KB figure, not a raw byte count", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). The size string this test reads off the row is what proves the
  // upload landed; a console line from a request retried behind it is not this test's failure.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  const title = `E2E filesize ${Date.now()}`;
  // 51200 bytes / 1024 = exactly 50 - no rounding ambiguity either side of the KB boundary.
  const bytes = Buffer.alloc(51200, "e");

  await gotoRoute(page, "documents", "Documents");
  await page.getByRole("button", { name: "Upload document" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "e2e-size.txt", mimeType: "text/plain", buffer: bytes });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(toast(page, "Document uploaded")).toBeVisible();

  try {
    const row = page.locator("tbody tr").filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("50 KB", { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await purge(page, await documentPath(page, title));
  }
});

async function documentPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/org-documents?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name: string }[] };
  const doc = results.find((d) => d.display_name === title);
  if (!doc) throw new Error(`e2e: the document "${title}" is not in the collection it was filed into`);
  return doc.path;
}
