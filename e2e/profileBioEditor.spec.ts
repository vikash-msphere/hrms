import { SPA_HEADERS, gotoRoute, personId, test, expect, toast } from "./fixtures";

// The "About me" bio editor - nothing in the suite has ever opened it, so none of what it actually does to
// what's typed has run: trailing spaces trimmed per line (but line breaks themselves kept - the profile
// renders them), a run of blank lines squashed to one, the counter warning under 20 characters left, and
// "Clear bio" replacing "Save" once the cleaned text comes out empty.
test("the bio editor cleans whitespace on save, and offers to clear an existing one", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("employee");

  // Whatever Eve's bio already is, this restores it exactly - a shared fixture person, not a throwaway.
  const id = await personId(page, "employee");
  const before = await page.request.get(`/v1/employees/${id}`);
  const original = before.ok() ? ((await before.json()) as { bio?: string }).bio ?? null : null;

  try {
    await gotoRoute(page, "profile", "Profile");
    const opener = page.getByRole("button", { name: "Edit bio" }).or(page.getByRole("button", { name: "Add a short bio" }));
    await opener.first().click();
    const dialog = page.getByRole("dialog").filter({ hasText: "About me" });
    await expect(dialog).toBeVisible();

    const textarea = dialog.getByPlaceholder(/A line about what you do/);
    // Trailing spaces on two lines, and four blank lines in the middle - both are cleaned on save, neither
    // is what the counter or the saved text should keep.
    await textarea.fill("Ships things.   \nAsk me about payroll.   \n\n\n\n\nStill here.");
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Bio saved")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    // Trimmed and squashed, not the raw paste - and the line breaks that were never the noise survive.
    // Read as `innerText`, not `toHaveText`: that matcher normalises whitespace, which would pass whether
    // or not the line breaks this is actually checking for survived at all.
    const bio = page.getByText("Ships things.", { exact: false });
    await expect(bio).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => bio.innerText()).toBe("Ships things.\nAsk me about payroll.\n\nStill here.");

    // Clearing it: the button reads "Clear bio" before it's pressed, not just "Save" over a blank field.
    await page.getByRole("button", { name: "Edit bio" }).click();
    const dialog2 = page.getByRole("dialog").filter({ hasText: "About me" });
    const textarea2 = dialog2.getByPlaceholder(/A line about what you do/);
    await textarea2.fill("");
    await expect(dialog2.getByRole("button", { name: "Clear bio", exact: true })).toBeVisible();
    await dialog2.getByRole("button", { name: "Clear bio", exact: true }).click();
    await expect(toast(page, "Bio saved")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Add a short bio" })).toBeVisible({ timeout: 15_000 });
  } finally {
    await page.request.patch(`/v1/employees/${id}/bio`, { headers: SPA_HEADERS, data: { bio: original } });
  }
});
