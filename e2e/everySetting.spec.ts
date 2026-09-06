import { readFileSync } from "node:fs";
import { gotoRoute, test, expect } from "./fixtures";

// Every settings panel, opened.
//
// Settings is a hub of ~40 panels, each one a lazily-imported chunk behind a route segment. That shape is
// exactly where rot is invisible: a panel nobody has opened since a refactor still has a card on the hub, a
// row in the rail and a working URL - and throws the moment it mounts. `test/manifestCompleteness.test.ts`
// and friends keep the SERVER side of settings honest; nothing else opens the panels.
//
// The list is not written down here. It is read from the registry that renders the hub
// (web/src/settings/registry.ts), so a panel added tomorrow is walked tomorrow, and one that is renamed
// without its title being updated fails on the heading it lands on.
const REGISTRY = readFileSync(new URL("../web/src/settings/registry.ts", import.meta.url), "utf8");

/** Org-scoped panels: `{ key: "…", title: "…" }` with no `scope:` of their own. A per-board or per-user entry
 *  has no instance to edit at `settings/<key>` and deliberately bounces to its host page instead. */
const PANELS = [...REGISTRY.matchAll(/\{ key: "([a-z0-9-]+)",(?! scope:) title: "([^"]+)"/g)].map((m) => ({
  key: m[1]!,
  title: m[2]!,
}));

test.describe("every setting", () => {
  test("the registry really was read", () => {
    // A regex that silently matches nothing would turn the walk below into a test that asserts nothing at
    // all - the failure mode worth guarding, since it looks like a pass.
    expect(PANELS.length).toBeGreaterThan(30);
    expect(PANELS.map((p) => p.key)).toContain("identity");
  });

  test("every org settings panel opens on its own heading", async ({ as }) => {
    // Forty panels, forty lazy chunks: long on purpose.
    test.setTimeout(600_000);
    const page = await as("super");
    let current = "";
    const logged: string[] = [];
    page.on("console", (m) => m.type() === "error" && logged.push(`${current}: ${m.text().slice(0, 200)}`));
    page.on("pageerror", (e) => logged.push(`${current}: threw ${e.message}`));

    const failures: string[] = [];
    for (const { key, title } of PANELS) {
      current = key;
      await gotoRoute(page, `settings/${key}`);
      try {
        // The panel's own `<h1>`, which is the registry title: landing on the hub (or on another panel)
        // means the key stopped resolving.
        await expect(page.locator("h1").first()).toHaveText(title, { timeout: 15_000 });
        // Lazily imported, so "the chunk arrived" is the skeleton being gone rather than the heading being
        // there - the heading is drawn by the page around it.
        await expect(page.getByRole("main")).not.toBeEmpty();
      } catch (e) {
        failures.push(`settings/${key}: ${(e as Error).message.split("\n")[0]}`);
      }
    }

    expect(failures, `panels that did not open:\n${failures.join("\n")}`).toEqual([]);
    expect(logged, `panels that logged an error:\n${logged.join("\n")}`).toEqual([]);
  });

  test("the hub finds a panel by a word that is not in its title", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "settings", "Settings");

    // The hub search reads titles, descriptions AND the keyword synonyms in the registry - which is the half
    // that makes it findable by what people actually call things.
    await page.getByPlaceholder(/Search settings/).fill("aadhaar");
    await expect(page.getByText("Employee identity fields")).toBeVisible();

    await page.getByPlaceholder(/Search settings/).fill("zzzz no such setting");
    await expect(page.getByText("No settings match")).toBeVisible();
  });

  test("a caller without settings access gets the wall, not the hub", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "settings");
    await expect(page.getByText("Restricted").or(page.getByText("You don't have access to this")).first()).toBeVisible();
    await expect(page.getByPlaceholder(/Search settings/)).toHaveCount(0);
  });
});
