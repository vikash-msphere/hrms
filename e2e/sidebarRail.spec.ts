import type { Request } from "@playwright/test";
import { gotoRoute, test, expect, makeThrowawayPerson, retireThrowawayPerson } from "./fixtures";

// The nav, made smaller.
//
// The sidebar has two pieces of state a person sets and expects to find again: the whole thing collapsed to
// an icon rail, and individual groups folded away. Both are kept on the person (a `preferences/nav` row, with
// a copy in this browser for first paint), and the failure they guard against is nasty in a quiet way: a rail
// that navigates to nothing, or a fold that eats the page you are on.
//
// What only a browser shows: collapsing really swaps the nav for the icon rail (the group headings go, the
// destinations stay reachable and still navigate), the choice survives a reload and follows the person into
// another browser rather than living in the page, and a folded group keeps the ACTIVE page visible - the one
// case where the app deliberately overrides what the person asked for, because hiding where they are standing
// is never right.
//
// Each test on a login of its own: the choices are now a server row, so a rail or a fold set on one of the
// seeded five would greet every other worker's browser signed in as them.

// The PATCH that carries the nav preference, once it holds `want`.
const navSaved = (want: (v: { rail?: boolean; collapsed?: string[] }) => boolean) => (r: Request) => {
  if (r.method() !== "PATCH" || !r.url().includes("/v1/preferences/nav")) return false;
  const body = r.postDataJSON() as { value?: { rail?: boolean; collapsed?: string[] } } | null;
  return !!body?.value && want(body.value);
};

test.describe("the sidebar", () => {
  test("collapsing leaves a rail that still navigates, and the choice survives a reload", async ({ as }) => {
    test.setTimeout(120_000);
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "Rail");
    try {
      const page = await as({ email: person.email });
      await gotoRoute(page, "dashboard");

      // Group headings are the part the rail gives up - the destinations keep their names (as labels on the
      // icons), so the headings are what tells the two layouts apart.
      await expect(page.getByRole("button", { name: "Workforce" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Workforce" })).toHaveCount(0);

      // Hovering the rail opens the full menu over the page, and leaving it folds the menu back. It overlays:
      // the page keeps its place, so nothing reflows under the pointer.
      // The collapse animates its width, so the page's left edge is read once it has settled beside the w-16 rail.
      const mainX = () => page.getByRole("main").boundingBox().then((b) => b!.x);
      await expect.poll(mainX).toBe(64);
      // Nor does the menu reflow vertically: the rail keeps a slot where each group heading goes, so the icon
      // under the pointer is the same height down the page once the labels and headings appear.
      const team = page.getByRole("link", { name: /^Team/ }).first();
      const teamY = () => team.boundingBox().then((b) => b!.y);
      const railY = await teamY();
      await team.hover();
      await expect(page.getByRole("button", { name: "Workforce" })).toBeVisible();
      expect(await mainX()).toBe(64);
      expect(await teamY()).toBe(railY);
      await page.getByRole("main").hover();
      await expect(page.getByRole("button", { name: "Workforce" })).toHaveCount(0);

      // A rail that cannot be navigated from is a decoration: the icons are still the links, named for anyone
      // who cannot see the picture.
      // `.first()` and a prefix match: a nav item's accessible name carries its unread badge ("Connect 2"), and
      // once the Directory is open the page's own workspace tab bar adds links of its own.
      await page.getByRole("link", { name: /^Team/ }).first().click();
      await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });

      // Written down, not held in the page.
      await page.reload();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible({ timeout: 30_000 });

      // And back, so the preference is a toggle rather than a one-way door.
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await expect(page.getByRole("button", { name: "Workforce" })).toBeVisible();
    } finally {
      await retireThrowawayPerson(admin, person.path);
    }
  });

  test("a folded group hides its pages, but never the one you are on, and both follow you to another browser", async ({ as }) => {
    test.setTimeout(120_000);
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "Fold");
    try {
      const page = await as({ email: person.email });
      await gotoRoute(page, "dashboard");
      const saved = page.waitForRequest(navSaved((v) => v.rail === true && !!v.collapsed?.includes("Workforce")), { timeout: 30_000 });

      // Folded from the dashboard, so the group being folded is NOT the one holding the current page.
      const workforce = page.getByRole("button", { name: "Workforce" });
      await expect(workforce).toHaveAttribute("aria-expanded", "true", { timeout: 30_000 });
      await workforce.click();
      await expect(workforce).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("link", { name: /^Team/ })).toHaveCount(0);

      // The rail folds the same groups: an icon it showed would vanish under the pointer as the sidebar opened.
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Dashboard/ })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Team/ })).toHaveCount(0);

      // A second browser has none of the first one's storage, so what it shows came from the person's row.
      await saved;
      const other = await as({ email: person.email });
      await gotoRoute(other, "dashboard");
      await expect(other.getByRole("button", { name: "Expand sidebar" })).toBeVisible({ timeout: 30_000 });
      await expect(other.getByRole("link", { name: /^Dashboard/ })).toBeVisible();
      await expect(other.getByRole("link", { name: /^Team/ })).toHaveCount(0);
      await other.getByRole("button", { name: "Expand sidebar" }).click();
      await expect(other.getByRole("button", { name: "Workforce" })).toHaveAttribute("aria-expanded", "false");

      // Now stand inside the folded group. Keeping it shut would leave the nav with no mark of where the reader
      // is, so the app opens it for as long as the page belongs to it.
      await gotoRoute(other, "employees", "Directory");
      await expect(other.getByRole("button", { name: "Workforce" })).toHaveAttribute("aria-expanded", "true", { timeout: 30_000 });
      await expect(other.getByRole("link", { name: /^Team/ }).first()).toBeVisible();
    } finally {
      await retireThrowawayPerson(admin, person.path);
    }
  });
});
