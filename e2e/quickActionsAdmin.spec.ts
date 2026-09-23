import { gotoRoute, patchOrgSettings, test, expect, toast } from "./fixtures";

type QuickGroup = { id?: string; label: string; items: string[] };

// The admin editor for the top-bar "+" (New) menu (Settings -> Quick create menu) - `quickCreate.spec.ts`
// only ever USES the menu in its built-in shape; nothing adds a section, renames it or moves an action into
// it. Every configurable action starts already placed in a built-in section (`defaultQuickMenu`), so this
// moves "Set a goal" - an action neither `quickCreate.spec.ts` nor anything else asserts the position of -
// into a section of this run's own, saves, and reads the whole thing back from cold.
test("a new section is added to the quick-create menu and an action is moved into it", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const groupLabel = `E2E section ${stamp}`;
  const ACTION_ID = "new-goal";
  const ACTION_LABEL = "Set a goal";

  const before = await page.request.get("/v1/settings/organization");
  const beforeGroups: QuickGroup[] = before.ok()
    ? (((await before.json()) as { value?: { quick_actions?: { groups?: QuickGroup[] } } }).value?.quick_actions?.groups ?? [])
    : [];
  // Where the action lived before this test moved it - the one fact cleanup needs from "before" that a fresh
  // re-read at cleanup time cannot recover, since by then this test's own move has already overwritten it.
  const originalGroupId = beforeGroups.find((g) => g.items.includes(ACTION_ID))?.id;

  try {
    // Retried as one whole unit: this panel's Save reads the WHOLE settings/organization blob at page-mount
    // and writes the whole thing back (Settings.tsx's useOrgBlob - "single-admin last-write-wins is fine", a
    // deliberate call for production's single-admin reality, not for this suite's many settings-panel specs
    // running at once) - a concurrent Save from another one of those (banks, letter defaults, default
    // department) whose OWN mount predates this change can silently overwrite `quick_actions` back to
    // whatever it was before this test ever touched it. Redone from a fresh mount whenever the reload or the
    // reread doesn't confirm it - guarded against re-adding a SECOND section of the same name if an earlier
    // pass's own Save actually landed and only its own verification lost the race.
    await expect(async () => {
      await gotoRoute(page, "settings/quick-actions", "Quick create menu");
      const goalRow = page.locator("div").filter({ hasText: ACTION_LABEL }).filter({ has: page.getByRole("combobox") }).last();

      if (!(await goalRow.getByRole("combobox").filter({ hasText: groupLabel }).count())) {
        const sectionInputs = page.getByPlaceholder("Section name");
        const values = await sectionInputs.all().then((els) => Promise.all(els.map((el) => el.inputValue())));
        if (!values.includes(groupLabel)) {
          await page.getByRole("button", { name: "Add section" }).click();
          await page.getByPlaceholder("Section name").last().fill(groupLabel);
        }
        // "Set a goal" already sits in a built-in section (every configurable action does by default) - moved
        // here by its own row's Select, not by dragging it out of "Not in the menu" (nothing starts there).
        // Deliberately not one of the STANDALONE_ACTION_IDS (raise a ticket, report a problem, clock in/out):
        // those have their own top-bar affordance and the org menu never governs them, so the editor has no
        // row for them at all - see web/src/lib/quickActions.ts. Give kudos IS configurable and does have a
        // row, since it has no button of its own.
        await goalRow.getByRole("combobox").click();
        await page.getByRole("option", { name: groupLabel, exact: true }).click();
        await page.getByRole("button", { name: "Save menu" }).click();
        await expect(toast(page, "Quick create menu saved")).toBeVisible({ timeout: 30_000 });
      }

      // From cold: the section and the move are the server's now, not the editor's own state.
      await page.reload();
      await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByPlaceholder("Section name").last()).toHaveValue(groupLabel, { timeout: 5_000 });
      const reloadedGoalRow = page.locator("div").filter({ hasText: ACTION_LABEL }).filter({ has: page.getByRole("combobox") }).last();
      await expect(reloadedGoalRow.getByRole("combobox")).toContainText(groupLabel, { timeout: 5_000 });

      const reread = await page.request.get("/v1/settings/organization");
      expect(reread.status(), await reread.text()).toBe(200);
      const groups = (((await reread.json()) as { value?: { quick_actions?: { groups?: { label: string; items: string[] }[] } } })
        .value?.quick_actions?.groups ?? []);
      const mine = groups.find((g) => g.label === groupLabel);
      expect(mine?.items).toContain(ACTION_ID);
    }).toPass({ timeout: 90_000 });
  } finally {
    // Only this spec's own two changes, undone on the row as it looks NOW: the added section removed, and
    // the action put back in whichever section it started in - not a snapshot from before this test's own
    // Save (definitely stale by cleanup time), which would take back out whatever another settings-panel
    // spec wrote to a different key of this same shared blob in the meantime.
    await patchOrgSettings(page, (blob) => {
      const quickActions = { ...((blob.quick_actions as { groups?: QuickGroup[] } | undefined) ?? {}) };
      const groups = (quickActions.groups ?? []).filter((g) => g.label !== groupLabel);
      if (originalGroupId) {
        for (const g of groups) {
          if (g.id === originalGroupId && !g.items.includes(ACTION_ID)) g.items = [...g.items, ACTION_ID];
          else if (g.id !== originalGroupId) g.items = g.items.filter((id) => id !== ACTION_ID);
        }
      }
      return { ...blob, quick_actions: { ...quickActions, groups } };
    });
  }
});
