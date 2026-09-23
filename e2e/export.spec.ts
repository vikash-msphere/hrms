import { gotoRoute, test, expect } from "./fixtures";

// Handing the person a file, built in their own browser.
//
// `lib/exportTable.ts` runs entirely client-side: CSV is assembled in memory, and Excel lazy-imports SheetJS
// (kept out of the main bundle) before building a workbook. Both then go out through a blob URL and a
// synthetic `<a download>` click. There is no server round trip to assert, no module to unit-test that would
// prove the chunk actually loads in a browser, and a broken lazy import fails at exactly one moment: when a
// real person clicks Excel.
//
// So: click it, catch the download, and read the bytes.
test.describe("table export", () => {
  test("CSV downloads with the table's rows in it", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors");

    await page.getByRole("button", { name: "Export" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "CSV", exact: true }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const path = await download.path();
    const csv = await readFile(path);
    // The header row the table drew, and at least one row under it.
    expect(csv).toContain("Vendor");
    expect(csv.trim().split(/\r?\n/).length).toBeGreaterThan(1);
  });

  test("Excel lazy-loads SheetJS and downloads a real workbook", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors");

    await page.getByRole("button", { name: "Export" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Excel (.xlsx)" }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const path = await download.path();
    const bytes = await readBytes(path);
    // "PK": an xlsx is a zip. A failed lazy import would give an empty or truncated file, not this.
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});

async function readFile(path: string | null): Promise<string> {
  return (await readBytes(path)).toString("utf8");
}

async function readBytes(path: string | null): Promise<Buffer> {
  if (!path) throw new Error("the download produced no file");
  const { readFile: read } = await import("node:fs/promises");
  return read(path);
}
