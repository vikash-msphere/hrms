import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// Filing a real file.
//
// An upload is a two-step flow the server suite can drive but never observe end to end: the dialog creates
// the document row, and only then does `api.upload` read the picked File's bytes and POST them to
// `:upload`. Everything that can go wrong lives in the browser half - a picker that hands the form nothing,
// a File whose bytes are never read, a second request that is fired before the row exists - and the toast
// says "uploaded" either way, because it is the row that was created, not the bytes, that the dialog is
// waiting on.
//
// So: pick a real file, let the app do both halves, and then ask the app to give the file back.
test("a picked file is filed as a document, and comes back with its bytes", async ({ as }) => {
  const page = await as("super");
  const title = `E2E uploaded doc ${Date.now()}`;

  await gotoRoute(page, "documents", "Documents");
  await page.getByRole("button", { name: "Upload document" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Upload document" })).toBeVisible();

  // The picker is `sr-only` rather than hidden so it stays keyboard-reachable; either way the file arrives
  // through the same change handler a person's file manager would use.
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "e2e-policy.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(PDF, "latin1"),
  });
  // What was attached is reported back before anything is submitted - the field is the only place a mistaken
  // pick can be noticed.
  await expect(dialog.getByText("e2e-policy.pdf")).toBeVisible();

  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();

  await expect(toast(page, "Document uploaded")).toBeVisible();
  const row = page.locator("tbody tr").filter({ hasText: title });
  await expect(row).toHaveCount(1);

  // The row survives a reload, and so do the bytes: downloading fetches the stored object as a blob and
  // hands it over through a synthetic `<a download>`, so a file whose first bytes are "%PDF-" is proof that
  // the File's contents - not an empty body from a File that was never read - made the whole trip.
  await page.reload();
  const filed = page.locator("tbody tr").filter({ hasText: title });
  await expect(filed).toHaveCount(1);

  await filed.getByRole("button", { name: "Actions" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download", exact: true }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("the download produced no file");
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  await purge(page, await documentPath(page, title));
});

/** The wire path of the document this spec filed, for taking it off the shelf again. */
async function documentPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/org-documents?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name: string }[] };
  const doc = results.find((d) => d.display_name === title);
  if (!doc) throw new Error(`e2e: the document "${title}" is not in the collection it was filed into`);
  return doc.path;
}

// The smallest thing a PDF reader will open: one empty page. Written out by hand rather than read from disk
// so the spec carries its own fixture.
const PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");
