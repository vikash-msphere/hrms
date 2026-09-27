import { readFileSync } from "node:fs";
import { hasCapability } from "../web/src/lib/perm";
import { SETTINGS_NAV_PERMS } from "../web/src/settings/registry";
import { ROLES, capabilitiesOf, gotoRoute, test, expect, type Role } from "./fixtures";

// The sidebar, for everybody, against the capabilities the server actually handed out.
//
// `boot.spec.ts` proves the hide-never-disable rule on ONE entry (Payroll) for ONE role. That is a smoke
// alarm, not coverage: the sidebar is eighteen entries, each gated on a different capability (or a union of
// them, for a workspace), and the failure this catches is silent in both directions - an entry that appears
// for somebody who gets a wall behind it, and an entry that stays hidden from somebody who holds it (a
// feature granted and then invisible, which reads to the grantee as the grant not working).
//
// Nothing here hard-codes who holds what: the gates are read out of `web/src/nav.ts`, the capabilities are
// read out of `/v1/users/me` for the role under test, and the expected answer is `hasCapability` - the app's
// own function, imported rather than re-implemented, so a change to the wildcard rules moves the test with
// the app. What is asserted is only that the sidebar agrees with that answer, which is the one thing no
// server test and no source scan can see.
type NavEntry = {
  key: string;
  label: string;
  /** Any one of these admits the entry. Empty = an identity surface, shown to every signed-in caller. */
  needs: string[];
};

const NAV_SRC = readFileSync(new URL("../web/src/nav.ts", import.meta.url), "utf8");

/** The `APPROVAL_CAPS` array, which the Approvals entry references by name rather than inlining. */
function approvalCaps(): string[] {
  const from = NAV_SRC.indexOf("export const APPROVAL_CAPS = [");
  const body = NAV_SRC.slice(from, NAV_SRC.indexOf("];", from));
  return [...new Set([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!))];
}

/**
 * Every top-level sidebar entry and the capabilities that admit it, parsed out of the NAV literal.
 *
 * Read from the source rather than written down here for the same reason `everySetting` reads the settings
 * registry: an entry added tomorrow is covered tomorrow, and a gate changed tomorrow fails the run rather
 * than quietly leaving the old answer asserted. Top-level items are the ones carrying an `icon:` (a tab
 * never does), and an item's capability set is the union of its own gate and its tabs' - which is exactly
 * `itemVisible()`: a workspace shows when ANY of its tabs does.
 */
function navEntries(): NavEntry[] {
  const body = NAV_SRC.slice(NAV_SRC.indexOf("export const NAV: NavGroup[] = ["), NAV_SRC.indexOf("const ALL_ITEMS"));
  const heads = [...body.matchAll(/key: "([a-z0-9-]+)",\s*label: "([^"]+)",\s*icon:/g)];
  return heads.map((head, i) => {
    const block = body.slice(head.index!, heads[i + 1]?.index ?? body.length);
    const needs = new Set<string>();
    for (const m of block.matchAll(/perm: "([^"]+)"/g)) needs.add(m[1]!);
    // `<collection>.read`, the same derivation `navPerm()` makes for an entry that names a collection
    // instead of spelling its gate out.
    for (const m of block.matchAll(/collection: "([^"]+)"/g)) needs.add(`${m[1]!}.read`);
    if (/anyPerm: APPROVAL_CAPS/.test(block)) for (const c of approvalCaps()) needs.add(c);
    // Computed from the settings registry, so it is imported rather than parsed.
    if (/anyPerm: SETTINGS_NAV_PERMS/.test(block)) for (const c of SETTINGS_NAV_PERMS) needs.add(c);
    for (const list of block.matchAll(/anyPerm: \[([^\]]*)\]/g)) {
      for (const m of list[1]!.matchAll(/"([^"]+)"/g)) needs.add(m[1]!);
    }
    return { key: head[1]!, label: head[2]!, needs: [...needs] };
  });
}

test.describe("sidebar access matrix", () => {
  test("the parsed nav is the whole sidebar and every entry declares a gate we can evaluate", () => {
    const entries = navEntries();
    // A sanity floor, so a regex that silently stops matching (a formatting change in nav.ts) fails here
    // rather than passing every role test with an empty list.
    expect(entries.length, "no nav entries were parsed out of web/src/nav.ts").toBeGreaterThan(10);
    expect(entries.map((e) => e.key)).toContain("dashboard");
    expect(entries.map((e) => e.key)).toContain("payroll-runs");
    // The two identity surfaces are the ONLY ungated entries. A new ungated entry is a decision, not a
    // typo, so it has to be made here on purpose.
    const ungated = entries.filter((e) => e.needs.length === 0).map((e) => e.key);
    expect(ungated.sort()).toEqual(["dashboard", "profile"]);
  });

  for (const role of Object.keys(ROLES) as Role[]) {
    test(`the sidebar shows ${role} exactly the entries they hold`, async ({ as }) => {
      test.setTimeout(120_000);
      const page = await as(role);
      await gotoRoute(page, "dashboard");

      const caps = await capabilitiesOf(page);
      const sidebar = page.getByRole("complementary");
      // The entry is found by its href, not its name: an entry with unread work carries a badge INSIDE the
      // anchor ("Approvals 3"), so an exact-name match would report a missing link that is on screen.
      await expect(sidebar.locator('a[href="/dashboard"]')).toHaveCount(1);

      const wrong: string[] = [];
      for (const entry of navEntries()) {
        const expected = entry.needs.length === 0 || entry.needs.some((p) => hasCapability(caps, p));
        const shown = (await sidebar.locator(`a[href="/${entry.key}"]`).count()) > 0;
        if (shown !== expected) {
          wrong.push(
            `${entry.label} (/${entry.key}): ${shown ? "offered to" : "hidden from"} a caller who ${expected ? "holds" : "does not hold"} ${entry.needs.join(" / ") || "(no gate)"}`,
          );
        }
      }
      expect(wrong, `the sidebar disagrees with the capabilities the server issued:\n${wrong.join("\n")}`).toEqual([]);
    });
  }

  test("an entry hidden from the sidebar is refused when its URL is typed anyway", async ({ as }) => {
    test.setTimeout(300_000);
    const page = await as("employee");
    await gotoRoute(page, "dashboard");

    const caps = await capabilitiesOf(page);
    const sidebar = page.getByRole("complementary");
    const hidden = navEntries().filter((e) => e.needs.length > 0 && !e.needs.some((p) => hasCapability(caps, p)));
    // If this role were to hold everything, the test below would assert nothing at all and still pass.
    expect(hidden.length, "the employee fixture holds every nav entry - nothing to prove refused").toBeGreaterThan(0);

    const served: string[] = [];
    for (const entry of hidden) {
      await expect(sidebar.locator(`a[href="/${entry.key}"]`)).toHaveCount(0);
      await gotoRoute(page, entry.key);
      const wall = page.getByText("You don't have access to this");
      try {
        await expect(wall).toBeVisible({ timeout: 20_000 });
      } catch {
        served.push(`${entry.label} (/${entry.key}) rendered for a caller the sidebar hides it from`);
      }
    }
    expect(served, `routes served past their own gate:\n${served.join("\n")}`).toEqual([]);
  });
});
