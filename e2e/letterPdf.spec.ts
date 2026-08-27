import { gotoRoute, test, expect, toast } from "./fixtures";

// A generated document, all the way to a file on disk.
//
// `test/letters.test.ts` renders the letter server-side and checks its bytes. What that leaves untested is
// the last hop, which is entirely the browser's: the app asks for the render, takes a blob back, names it,
// and hands it over through a synthetic `<a download>`. If that chain breaks - a wrong content type, a
// revoked object URL, a filename the OS refuses - the server test still passes and the person gets nothing.
//
// The 20 letter templates come from scripts/templates.sql, so this needs no fixture data of its own.
test("generating a letter downloads a real PDF", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "documents");

  await page.getByRole("button", { name: "Generate letter" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Generate letter")).toBeVisible();

  // Who it is for: a searchable picker, not a select - the org can have thousands of people in it.
  await dialog.getByRole("button", { name: /Select an employee/ }).click();
  await page.getByPlaceholder("Search employees…").fill("Eve");
  await page.getByRole("button", { name: "Eve Employee", exact: true }).click();

  // Which letter: the templates come from scripts/templates.sql. "Employment Verification" is one that needs
  // no extra typed input, so this stays a test of the render-and-download chain rather than of a form.
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Employment Verification" }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Generate", exact: true }).click(),
  ]);

  await expect(toast(page, "Letter generated")).toBeVisible();
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  const path = await download.path();
  if (!path) throw new Error("the download produced no file");
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  // A PDF, not an error page saved with a .pdf name.
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);
});
