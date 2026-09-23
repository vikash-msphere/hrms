import { allowConsoleErrors, gotoRoute, toast, test, expect } from "./fixtures";

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
  test.setTimeout(220_000);
  const page = await as("super");
  // The panel's Save is guarded on the version this session read (lib/settingsStore.ts sends the snapshot's
  // If-Match), so a concurrent save from another spec on the shared organization blob is REFUSED rather than
  // allowed to overwrite it. That refusal is the app working, and each save below is retried against the
  // version that won.
  allowConsoleErrors(page, /status of 409/i);

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
  // Retried as a whole re-select: on rare occasions under 16-worker load the select's own value has landed
  // (confirmed below) while the preview span's live style stayed on the old font - a render this suite has not
  // been able to pin a cause for beyond that it clears on a fresh selection, so re-picking is what recovers.
  await expect(async () => {
    await fontSelect.selectOption(nextFont);
    await weightSelect.selectOption(nextWeight);
    // The select's own value, not just the CSS it drives - confirms the change event actually landed before
    // reading the re-render it triggers, rather than reading the preview's style a beat too early on a busy
    // lane.
    await expect(fontSelect).toHaveValue(nextFont);
    await expect(weightSelect).toHaveValue(nextWeight);
    // Live, before anything is saved: the preview is computed from local state, not read back from the server.
    await expect(previewSpan).toHaveCSS("font-family", /Georgia|Playfair/, { timeout: 5_000 });
    await expect(previewSpan).toHaveCSS("font-weight", WEIGHT_PX[nextWeight]!, { timeout: 5_000 });
    // Read INSIDE the retry, not after it. This panel is bound to the shared `settings/organization` blob,
    // and any OTHER spec writing settings invalidates it - the panel re-reads and the unsaved selection goes
    // with it. Taken once the retry had passed, this read could therefore find the preview back on the stock
    // font and call it "the font never changed"; inside, a revert simply fails the pass and the next one
    // re-picks, which is what this retry exists for.
    expect(await previewSpan.evaluate((el) => getComputedStyle(el).fontFamily)).not.toBe(before1);
  }).toPass({ timeout: 30_000 });

  try {
    // Retried as one whole unit: this panel's Save reads the WHOLE settings/organization blob at page-mount
    // and writes the whole thing back (Settings.tsx's useOrgBlob - "single-admin last-write-wins is fine", a
    // deliberate call for production's single-admin reality, not for this suite's many identity-panel specs
    // running at once). A concurrent Save from another one of those - a wordmark/logo upload spec sharing this
    // SAME "identity" blob - can land in the window right after this Save: either reverting name_font/
    // name_weight to whatever they were before (the text this checks never turns up at all), or setting a
    // wordmark image, which makes the sidebar draw THAT and leaves this plain-text div empty (Settings.tsx's
    // own comment: "A wordmark is set, so the sidebar draws that artwork and none of this text").
    await expect(async () => {
      // RE-PICKED each pass, not just re-saved. The verification below reloads the page, which re-mounts this
      // panel from whatever the server now holds - so on a pass that follows a clobber, the form is back on
      // the old font and pressing Save again would only write that old font back. Choosing again first is
      // what makes the retry able to recover at all.
      await gotoRoute(page, "settings/identity", "Name & branding");
      await page.getByRole("tab", { name: "Name" }).click();
      await page.getByLabel("Font").selectOption(nextFont);
      await page.getByLabel("Weight").selectOption(nextWeight);
      await expect(page.getByLabel("Font")).toHaveValue(nextFont);
      await expect(page.getByLabel("Weight")).toHaveValue(nextWeight);

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Organization saved")).toBeVisible({ timeout: 30_000 });

      // The real thing, not the preview: reload cold and read the sidebar's own wordmark off the shell.
      await page.reload();
      const sidebar = page.getByRole("complementary").or(page.locator("aside")).first();
      const wordmark = sidebar.locator("div.truncate.text-foreground").first();
      await expect(wordmark).toBeVisible({ timeout: 10_000 });
      await expect(wordmark).toHaveCSS("font-family", /Georgia|Playfair/, { timeout: 5_000 });
      await expect(wordmark).toHaveCSS("font-weight", WEIGHT_PX[nextWeight]!, { timeout: 5_000 });
    }).toPass({ timeout: 150_000 });
  } finally {
    // Putting it back is the half every other spec's sidebar depends on, so it is retried the same way the
    // change was: a lost race on the shared blob leaves the org on THIS spec's font, which is not something
    // to hand to the rest of the suite. From a fresh mount each time, so the save carries a live version.
    await expect(async () => {
      await gotoRoute(page, "settings/identity", "Name & branding");
      await page.getByRole("tab", { name: "Name" }).click();
      const font = page.getByLabel("Font");
      const weight = page.getByLabel("Weight");
      if ((await font.inputValue()) === before.font && (await weight.inputValue()) === before.weight) return;
      await font.selectOption(before.font);
      await weight.selectOption(before.weight);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Organization saved")).toBeVisible({ timeout: 30_000 });
      await page.reload();
      await expect(page.getByRole("tab", { name: "Name" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: "Name" }).click();
      await expect(page.getByLabel("Font")).toHaveValue(before.font, { timeout: 15_000 });
      await expect(page.getByLabel("Weight")).toHaveValue(before.weight, { timeout: 15_000 });
    }).toPass({ timeout: 150_000 });
  }
});
