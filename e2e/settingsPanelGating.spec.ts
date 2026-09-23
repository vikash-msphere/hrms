import { readFileSync } from "node:fs";
import { hasCapability } from "../web/src/lib/perm";
import { capabilitiesOf, gotoRoute, test, expect } from "./fixtures";

// Settings is not one permission.
//
// `settings.write` opens the hub; each panel behind it can require a capability of its OWN (`perm:` in
// web/src/settings/registry.ts) - "Pay grades" wants `pay-grades.write`, "API keys" wants `api-keys.read`,
// "System operations" wants `cron-runs.read`. That second gate is what lets an org give HR the settings hub
// without handing over the machine credentials and the maintenance jobs, and it is applied in exactly two
// places: the hub's card list, and the deep link to `settings/<key>`.
//
// `everySetting` opens every panel as an admin - which is the sweep that proves they MOUNT and, by
// construction, can say nothing about who else may open them. Nothing else looks at the second gate at all,
// in either of its two places.
//
// The panel list is read from the registry, so a panel added tomorrow is judged tomorrow.
type Panel = { key: string; title: string; perm?: string };

function panels(): Panel[] {
  const src = readFileSync(new URL("../web/src/settings/registry.ts", import.meta.url), "utf8");
  return src
    .split("\n")
    .filter((line) => line.trimStart().startsWith('{ key: "'))
    // `key` and `title` are not always adjacent: a `scope: "object"`/`scope: "user"` entry (a contextual
    // panel launched from its own page, e.g. board config or notification-prefs - never a hub card) carries
    // other fields between them. Matched independently rather than as one anchored pattern, and dropped
    // entirely: it carries no `perm:` hub gate to test, and is not reachable from the hub's card list or its
    // `settings/<key>` deep link either.
    .filter((line) => !/\bscope: "(object|user)"/.test(line))
    .map((line) => {
      const key = /\{ key: "([a-z0-9-]+)"/.exec(line)?.[1];
      const title = /\btitle: "([^"]+)"/.exec(line)?.[1];
      const perm = /\bperm: "([^"]+)"/.exec(line)?.[1];
      return key && title ? { key, title, ...(perm ? { perm } : {}) } : undefined;
    })
    .filter((p): p is Panel => !!p);
}

test.describe("settings panel gating", () => {
  test("the registry parses, and some panels really do carry a second gate", () => {
    const all = panels();
    expect(all.length, "no settings panels were parsed out of the registry").toBeGreaterThan(20);
    const gated = all.filter((p) => p.perm);
    expect(gated.length, "no panel carries its own capability - the gate under test has gone").toBeGreaterThan(5);
  });

  test("HR is shown the hub cards it holds and none of the others", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("hr");
    await gotoRoute(page, "settings", "Settings");
    const caps = await capabilitiesOf(page);

    const wrong: string[] = [];
    for (const panel of panels()) {
      const expected = !panel.perm || hasCapability(caps, panel.perm);
      const shown = (await page.getByText(panel.title, { exact: true }).count()) > 0;
      if (shown !== expected) {
        wrong.push(`${panel.title}: ${shown ? "offered without" : "withheld despite"} ${panel.perm ?? "(no gate)"}`);
      }
    }
    expect(wrong, `settings cards that disagree with the caller's capabilities:\n${wrong.join("\n")}`).toEqual([]);
  });

  test("a panel HR may not open is not served by its URL either", async ({ as }) => {
    test.setTimeout(300_000);
    const page = await as("hr");
    await gotoRoute(page, "settings", "Settings");
    const caps = await capabilitiesOf(page);
    const hidden = panels().filter((p) => p.perm && !hasCapability(caps, p.perm));
    // A run where HR happened to hold everything would assert nothing at all and still pass.
    expect(hidden.length, "HR holds every gated settings panel - nothing to prove refused").toBeGreaterThan(0);

    const served: string[] = [];
    for (const panel of hidden) {
      await gotoRoute(page, `settings/${panel.key}`);
      // The hub, not the panel: a key the caller may not open falls back rather than rendering (Settings.tsx
      // `if (!entry || !canSee(...)) return <SettingsHub/>`).
      try {
        await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 20_000 });
      } catch {
        served.push(`settings/${panel.key} did not fall back to the hub for a caller without ${panel.perm}`);
      }
    }
    expect(served, `settings panels served past their own gate:\n${served.join("\n")}`).toEqual([]);
  });

  test("a caller without settings.write gets the wall, whatever the panel would have allowed", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("manager");
    const caps = await capabilitiesOf(page);
    expect(hasCapability(caps, "settings.write"), "the manager fixture now holds settings.write").toBe(false);

    await gotoRoute(page, "settings");
    await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
    // And a deep link past the hub is the same answer: the route gate is the hub's gate.
    await gotoRoute(page, "settings/identity");
    await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  });
});
