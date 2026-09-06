import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// The admin editor for the top-bar "+" (New) menu (Settings -> Quick create menu) - `quickCreate.spec.ts`
// only ever USES the menu in its built-in shape; nothing adds a section, renames it or moves an action into
// it. Every configurable action starts already placed in a built-in section (`defaultQuickMenu`), so this
// moves "Give kudos" - an action neither `quickCreate.spec.ts` nor anything else asserts the position of -
// into a section of this run's own, saves, and reads the whole thing back from cold.
test("a new section is added to the quick-create menu and an action is moved into it", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const groupLabel = `E2E section ${stamp}`;

  const before = await page.request.get("/v1/settings/organization");
  const previous = before.ok() ? ((await before.json()) as { value?: Record<string, unknown> }).value ?? {} : {};

  try {
    await gotoRoute(page, "settings/quick-actions", "Quick create menu");

    await page.getByRole("button", { name: "Add section" }).click();
    const sectionInput = page.getByPlaceholder("Section name").last();
    await sectionInput.fill(groupLabel);

    // "Give kudos" already sits in a built-in section (every configurable action does by default) - moved
    // here by its own row's Select, not by dragging it out of "Not in the menu" (nothing starts there).
    const kudosRow = page.locator("div").filter({ hasText: "Give kudos" }).filter({ has: page.getByRole("combobox") }).last();
    await kudosRow.getByRole("combobox").click();
    await page.getByRole("option", { name: groupLabel, exact: true }).click();

    await page.getByRole("button", { name: "Save menu" }).click();
    await expect(toast(page, "Quick create menu saved")).toBeVisible({ timeout: 30_000 });

    // From cold: the section and the move are the server's now, not the editor's own state.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByPlaceholder("Section name").last()).toHaveValue(groupLabel, { timeout: 30_000 });
    const reloadedKudosRow = page.locator("div").filter({ hasText: "Give kudos" }).filter({ has: page.getByRole("combobox") }).last();
    await expect(reloadedKudosRow.getByRole("combobox")).toContainText(groupLabel);

    const reread = await page.request.get("/v1/settings/organization");
    expect(reread.status(), await reread.text()).toBe(200);
    const groups = (((await reread.json()) as { value?: { quick_actions?: { groups?: { label: string; items: string[] }[] } } })
      .value?.quick_actions?.groups ?? []);
    const mine = groups.find((g) => g.label === groupLabel);
    expect(mine?.items).toContain("give-kudos");
  } finally {
    await page.request.patch("/v1/settings/organization", { headers: SPA_HEADERS, data: { value: previous } });
  }
});
