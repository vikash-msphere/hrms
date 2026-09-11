import { SPA_HEADERS, gotoRoute, inDays, purge, test, expect, toast } from "./fixtures";

// Renewing an expired document - one action that replaces the file AND moves the expiry on, so nobody
// re-uploads the same paperwork and forgets the date. Offered only once a document actually carries an
// expiry and has lapsed or is about to (`d.expire_time && expiryBucket(d) !== "Valid"`); the "Replace file" /
// "Upload file" item every other document spec exercises is a plain upload with no date logic at all -
// "Renew" is the one row action on this page that has never been pressed anywhere.
test("renewing an expired document uploads new paperwork and moves the expiry on a year", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const title = `E2E renew ${Date.now() % 1_000_000}`;
  // 60 days stale rather than a plain "today": `renewedExpiry` (web/src/pages/Documents.tsx) measures from
  // the date that lapsed - it falls back to today only when there was no PRIOR expiry to measure from at
  // all, so a fixed 60-days-ago date exercises the actual "measured from when it lapsed" arithmetic rather
  // than trivially matching whatever "today + 1 year" would also produce.
  const expired = inDays(-60);
  const expectedRenewal = (() => {
    // Local calendar arithmetic throughout, matching `renewedExpiry` itself: `.toISOString()` here would
    // convert back through UTC and land a day early/late in any timezone with a non-zero offset.
    const d = new Date(`${expired}T00:00:00`);
    d.setFullYear(d.getFullYear() + 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  const made = await page.request.post("/v1/org-documents", {
    headers: SPA_HEADERS,
    // UTC midnight on the expiry day, the shape `expire_time` is published as (openapi.yaml) and the shape
    // the page itself writes: it reads back sliced to the same day the assertions below measure from.
    data: { display_name: title, document_type: "POLICY", expire_time: `${expired}T00:00:00Z` },
  });
  expect(made.status(), await made.text()).toBe(200);
  const doc = (await made.json()) as { path: string };

  try {
    await gotoRoute(page, "documents", "Documents");
    const row = page.locator("tbody tr").filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/Expired/i);

    await row.getByRole("button", { name: "Actions" }).click();
    // The label names the date it moves TO - a year on from the lapsed one, since renewal measures from the
    // window that just expired rather than from today.
    const renewItem = page.getByRole("menuitem", { name: /^Renew to/ });
    await expect(renewItem).toBeVisible({ timeout: 30_000 });
    const renewLabel = (await renewItem.innerText()).trim();
    await renewItem.click();

    await page.locator('input[type="file"]').setInputFiles({
      name: "e2e-renewed.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%E2E renewed paperwork\n"),
    });
    await expect(toast(page, "Renewed")).toBeVisible({ timeout: 30_000 });

    // Off the outstanding list: "Valid" draws no badge at all (only Expired/Soon do), so the row reading
    // clean of both is what "no longer outstanding" looks like here.
    await expect(row.getByText("Expired", { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(row.getByText("Soon", { exact: true })).toHaveCount(0);
    // And the menu agrees: a valid document offers no renewal.
    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menuitem", { name: /^Renew to/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    const after = await reread(page, title);
    expect(after.expire_time, "expire_time was never moved").toBeTruthy();
    expect(after.expire_time!.slice(0, 10)).toBe(expectedRenewal);
    expect(renewLabel).toContain(expectedRenewal.slice(0, 4));
  } finally {
    await purge(page, doc.path);
  }
});

async function reread(page: import("@playwright/test").Page, title: string): Promise<{ expire_time?: string }> {
  const res = await page.request.get("/v1/org-documents?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { display_name?: string; expire_time?: string }[] };
  const found = results.find((d) => d.display_name === title);
  if (!found) throw new Error(`e2e: no org-document on file titled ${title}`);
  return found;
}
