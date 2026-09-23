import { readFileSync } from "node:fs";
import { hasCapability } from "../web/src/lib/perm";
import { ROLES, capabilitiesOf, gotoRoute, test, expect, type Role } from "./fixtures";

// The "+" menu is a list of things you can do. It must not be a list of things you cannot.
//
// Every entry in `web/src/lib/quickActions.ts` carries its own `visible(me)` predicate, almost all of them a
// capability check, and the menu is assembled from those at render time. `everyQuickAction` walks the whole
// registry as an admin - which proves the actions still WORK and, by construction, says nothing about who is
// offered them. A quick action is a two-step press (navigate, then fire an intent the page opens its create
// dialog from), so an action offered to somebody without the grant does not fail politely: it takes them to a
// page and opens a form whose submit can only 403.
//
// The assertion is one-directional on purpose. What the menu SHOWS is also filtered by the org's own menu
// configuration (Settings › Quick create menu), so "this action is missing" can be an org's choice rather
// than a bug - but "this action is offered to somebody who does not hold its capability" can never be.
type Action = { id: string; label: string; capability: string };

/** Registry entries whose visibility is a capability check, read from the source that renders the menu. */
function actions(): Action[] {
  const src = readFileSync(new URL("../web/src/lib/quickActions.ts", import.meta.url), "utf8");
  const out: Action[] = [];
  for (const line of src.split("\n")) {
    const head = /\{ id: "([a-z0-9-]+)", label: "([^"]+)"/.exec(line);
    const cap = /hasCapability\(me\.capabilities, "([^"]+)"\)/.exec(line);
    if (head && cap) out.push({ id: head[1]!, label: head[2]!, capability: cap[1]! });
  }
  return out;
}

test.describe("quick action gates", () => {
  test("the registry parses", () => {
    const all = actions();
    expect(all.length, "no capability-gated quick actions were parsed out of the registry").toBeGreaterThan(10);
    expect(all.map((a) => a.id)).toContain("request-leave");
  });

  for (const role of Object.keys(ROLES) as Role[]) {
    test(`the "+" menu offers ${role} nothing they cannot do`, async ({ as }) => {
      test.setTimeout(120_000);
      const page = await as(role);
      await gotoRoute(page, "dashboard");
      const caps = await capabilitiesOf(page);

      const trigger = page.getByRole("button", { name: "New", exact: true });
      // A caller with no quick actions at all gets no button - which is itself the rule working.
      if (!(await trigger.count())) {
        expect(actions().filter((a) => hasCapability(caps, a.capability)), "the menu is missing for somebody who holds actions").toEqual([]);
        return;
      }
      await trigger.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible({ timeout: 15_000 });

      const offered = (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
      expect(offered.length, "the menu opened with nothing in it").toBeGreaterThan(0);

      const leaked = actions().filter((a) => offered.includes(a.label) && !hasCapability(caps, a.capability));
      expect(
        leaked.map((a) => `${a.label} (needs ${a.capability})`),
        "the + menu offered actions the caller cannot perform",
      ).toEqual([]);

      // Every label on the menu is a registry action, not something assembled from elsewhere - otherwise the
      // check above could pass by simply never recognising the rows.
      const known = new Set(actions().map((a) => a.label));
      expect(offered.filter((label) => !known.has(label)), "the menu drew rows that are in no registry entry").toEqual([]);
    });
  }

  test("an employee is offered their own actions and not an admin's", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("employee");
    await gotoRoute(page, "dashboard");
    await page.getByRole("button", { name: "New", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 15_000 });

    // Self-service is theirs…
    await expect(menu.getByRole("menuitem", { name: "Request leave" })).toBeVisible();
    // …and the administrative ones are not. Named rather than derived, so this stays a statement about what
    // an ordinary person may do rather than a restatement of the loop above.
    for (const label of ["Add an employee", "Open a job", "Add a candidate", "Upload a document"]) {
      await expect(menu.getByRole("menuitem", { name: label }), `an employee was offered "${label}"`).toHaveCount(0);
    }
  });
});
