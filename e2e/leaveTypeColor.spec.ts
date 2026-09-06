import { gotoRoute, purge, test, expect } from "./fixtures";

// One colour, everywhere a leave type is shown - not a swatch that only ever paints its own row.
//
// `lib/leaveColors.ts` is a shared function specifically so a type's colour cannot drift between the picker,
// the type's own row and the calendar/timeline pills it decorates. What only a browser can show is the loop
// actually closing: the swatch picked in the form has to be the exact hex the row then paints itself with -
// not a nearby shade, not the auto-derived fallback the module falls back to when nothing was chosen.
test("a picked swatch is the exact colour the leave type's own row paints", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E colour ${Date.now()}`;
  // A specific swatch from LEAVE_COLORS (lib/leaveColors.ts) - not the first one, so this fails if the picker
  // silently always applies whichever swatch happens to render first.
  const hex = "#f43f5e";

  await gotoRoute(page, "settings/leave-types");
  await page.getByRole("button", { name: "New leave type" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByRole("button", { name: "Choose color" }).click();
  await page.getByRole("button", { name: hex, exact: true }).click();
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    const dot = row.locator("span.rounded-full").first();
    await expect(dot).toHaveCSS("background-color", hexToRgb(hex));
  } finally {
    await purgeLeaveType(page, name);
  }
});

/** `toHaveCSS` reads the resolved value, which is always rgb() - so the hex the swatch was picked by has to
 *  be converted to compare against it. */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function purgeLeaveType(page: import("@playwright/test").Page, name: string): Promise<void> {
  const res = await page.request.get("/v1/leave-types?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  const row = results.find((t) => t.display_name === name);
  if (row) await purge(page, row.path);
}
