import { hasCapability } from "../web/src/lib/perm";
import { SETTINGS_REGISTRY, entryScope, hasAnySettings, settingsEntryVisible, type SettingsEntry } from "../web/src/settings/registry";
import { capabilitiesOf, gotoRoute, test, expect } from "./fixtures";

// Settings is not one permission.
//
// Each panel is offered to whoever can write what it edits (web/src/settings/registry.ts
// settingsEntryVisible): HR's leave and attendance policy, payroll's CTC and tax slabs, super admin's
// governance switches (four-eyes, sign-in, AI) - each a setting key a role is granted by name
// (`settings.<key>`), or a collection it writes, plus any `perm:` the panel names on top. That rule is applied
// in three places: the hub's card list, the deep link to `settings/<key>`, and the nav/page gate (any panel at
// all). `everySetting` opens every panel as an admin - which proves they MOUNT and says nothing about who
// else may open them.
//
// The expectation is the registry's own rule, evaluated against the capabilities the server hands this caller,
// so a panel added tomorrow is judged tomorrow and a role whose grants change is judged by what it now holds.
const orgPanels = (): SettingsEntry[] => SETTINGS_REGISTRY.filter((e) => entryScope(e) === "org");

test.describe("settings panel gating", () => {
  test("the registry has panels owned by different roles - the gate under test is real", () => {
    const all = orgPanels();
    expect(all.length, "no settings panels in the registry").toBeGreaterThan(20);
    const perKey = all.filter((e) => e.target?.collection === "settings" && e.target.objectPath);
    expect(perKey.length, "no panel edits a setting key - the per-key gate under test has gone").toBeGreaterThan(10);
  });

  for (const role of ["hr", "payroll"] as const) {
    test(`${role} is shown the hub cards it owns and none of the others`, async ({ as }) => {
      test.setTimeout(180_000);
      const page = await as(role);
      await gotoRoute(page, "settings", "Settings");
      const caps = await capabilitiesOf(page);

      // Cards in the hub itself, not text anywhere on the page: "Expenses" is also a sidebar link.
      const hub = page.getByRole("main");
      const wrong: string[] = [];
      for (const e of orgPanels()) {
        const expected = settingsEntryVisible(caps, e);
        const shown = (await hub.getByText(e.title, { exact: true }).count()) > 0;
        if (shown !== expected) wrong.push(`${e.title}: ${shown ? "offered but not writable" : "withheld though writable"}`);
      }
      expect(wrong, `settings cards that disagree with the caller's capabilities:\n${wrong.join("\n")}`).toEqual([]);
    });
  }

  test("a panel HR may not open is not served by its URL either", async ({ as }) => {
    test.setTimeout(300_000);
    const page = await as("hr");
    await gotoRoute(page, "settings", "Settings");
    const caps = await capabilitiesOf(page);
    const hidden = orgPanels().filter((e) => !settingsEntryVisible(caps, e));
    // A run where HR happened to hold everything would assert nothing at all and still pass. HR must not hold
    // the governance switches or payroll's configuration.
    expect(hidden.map((e) => e.key)).toEqual(expect.arrayContaining(["ai", "sign-in", "payroll-policy", "payslip-design"]));

    const served: string[] = [];
    for (const e of hidden) {
      await gotoRoute(page, `settings/${e.key}`);
      // The hub, not the panel: a key the caller may not open falls back rather than rendering (Settings.tsx
      // `if (!entry || !canSee(...)) return <SettingsHub/>`).
      try {
        await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
      } catch {
        served.push(`settings/${e.key} did not fall back to the hub for a caller who cannot write it`);
      }
    }
    expect(served, `settings panels served past their own gate:\n${served.join("\n")}`).toEqual([]);
  });

  test("a caller who owns no panel gets the wall, whatever the panel would have allowed", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("manager");
    const caps = await capabilitiesOf(page);
    expect(hasAnySettings(caps), "the manager fixture now owns a settings panel").toBe(false);
    expect(hasCapability(caps, "settings.write")).toBe(false);

    await gotoRoute(page, "settings");
    await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
    // And a deep link past the hub is the same answer: the route gate is the hub's gate.
    await gotoRoute(page, "settings/identity");
    await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  });
});
