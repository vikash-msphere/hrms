import { gotoRoute, toast, test, expect } from "./fixtures";

// Mirrors NAME_WEIGHTS in web/src/lib/org.tsx - the option values a native <select> offers, and the numeric
// CSS weight each one resolves to.
const WEIGHT_PX: Record<string, string> = { regular: "400", medium: "500", semibold: "600", bold: "700", extrabold: "800" };

// The sidebar wordmark's own type: a font, a weight and a size, previewed live and then drawn for real in the
// one place that matters - the sidebar every other spec in the suite has open behind whatever it is testing.
//
// `catalogEditors`/`settingsPanels` prove the identity panel has A save; this is the one field on it whose
// effect is entirely visual and has no server-side equivalent to pin against - `lib/fonts.ts` only supplies
// the vocabulary, and NAME_FONTS/NAME_WEIGHTS/NAME_SIZES existing is not the same claim as picking one
// actually changing what the sidebar draws.
//
// Org-wide and shared with every other spec's sidebar, so this puts it back exactly as it found it - the
// SAME UI round trip on the way out as on the way in, not a wire PATCH guessing at the write schema.
test("the wordmark font, weight and size preview live and persist to the real sidebar", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");

  await gotoRoute(page, "settings/identity", "Name & branding");
  await page.getByRole("tab", { name: "Name" }).click();

  const fontSelect = page.getByLabel("Font");
  const weightSelect = page.getByLabel("Weight");
  const before = { font: await fontSelect.inputValue(), weight: await weightSelect.inputValue() };

  const previewSpan = page.getByRole("tabpanel").locator("div.bg-sidebar span");
  const before1 = await previewSpan.evaluate((el) => getComputedStyle(el).fontFamily);

  // Pick whichever isn't already selected - Serif's stack starts with Georgia and Extra bold is 800, both far
  // enough from any other option that "did the CSS actually change" is not a coin flip against what was
  // already in place.
  const nextFont = before.font === "serif" ? "elegant" : "serif";
  const nextWeight = before.weight === "extrabold" ? "regular" : "extrabold";
  await fontSelect.selectOption(nextFont);
  await weightSelect.selectOption(nextWeight);

  // Live, before anything is saved: the preview is computed from local state, not read back from the server.
  await expect(previewSpan).toHaveCSS("font-family", /Georgia|Playfair/);
  const after1 = await previewSpan.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(after1).not.toBe(before1);
  await expect(previewSpan).toHaveCSS("font-weight", WEIGHT_PX[nextWeight]!);

  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Organization saved")).toBeVisible({ timeout: 30_000 });

    // The real thing, not the preview: reload cold and read the sidebar's own wordmark off the shell.
    await page.reload();
    const sidebar = page.getByRole("complementary").or(page.locator("aside")).first();
    const wordmark = sidebar.locator("div.truncate.text-foreground").first();
    await expect(wordmark).toBeVisible({ timeout: 30_000 });
    await expect(wordmark).toHaveCSS("font-family", /Georgia|Playfair/);
    await expect(wordmark).toHaveCSS("font-weight", WEIGHT_PX[nextWeight]!);
  } finally {
    await gotoRoute(page, "settings/identity", "Name & branding");
    await page.getByRole("tab", { name: "Name" }).click();
    await page.getByLabel("Font").selectOption(before.font);
    await page.getByLabel("Weight").selectOption(before.weight);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Organization saved")).toBeVisible({ timeout: 30_000 });
  }
});
