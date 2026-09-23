import { gotoRoute, test, expect } from "./fixtures";

// The org chart as a picture - `orgChart.spec.ts` owns the tree itself, but nothing exercises rasterizing
// what's on screen into a file. `exportChart` hides every interactive control behind a CSS attribute,
// prepends a title band, rasterizes the live DOM with html-to-image, and hands the result to a synthetic
// `<a download>` - none of which has a server-side equivalent to fall back on, so a broken export is
// invisible to every other test in the suite.
test("the org chart is exported as a real PNG", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  await gotoRoute(page, "org-chart", "Org Chart");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download as PNG" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^org-chart-.*\.png$/);

  const path = await download.path();
  if (!path) throw new Error("the download produced no file");
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  // The PNG signature, not just a file with the right name - a canvas that rendered blank or an export that
  // silently caught its own error would still leave *something* named org-chart-*.png behind.
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(bytes.length).toBeGreaterThan(1000);
});
