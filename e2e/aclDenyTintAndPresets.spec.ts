import type { Page } from "@playwright/test";
import { SPA_HEADERS, accessRules, gotoRoute, toast, test, expect } from "./fixtures";

// Two things the access UI does that exist only to be LOOKED at.
//
// A deny is the one rule that cannot be inferred from anything on screen: it grants nothing, so a target it
// covers looks exactly like a target nobody has touched, and the person wondering why a grant "did not work"
// has no way to find it short of opening every modal in the app. That is what the red key is for - in access
// mode a target with an explicit deny over it is tinted and says so in its tooltip.
//
// The presets are the other: three one-press bundles that author the canonical Everyone shapes (read-only
// wall, open box, self-service) instead of hand-assembling the same two or three rules on every engagement
// collection. Both are pure browser behaviour - there is no server call that "is" the tint, and a preset is
// just rules once it has run - and neither has ever been exercised.
//
// The deny is written for a role nobody holds, and the preset is applied to `pay-grades`: a collection with
// no sidebar entry, so a temporary org-wide read cannot move another spec's nav or route assertions.
test.describe("deny visibility and presets", () => {
  test("a deny tints the key that covers it, and says so", async ({ as }) => {
    test.setTimeout(300_000);
    const page = await as("super");
    const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
    const name = `e2e_tint_${stamp}`;
    const label = `E2E Tint Role ${stamp}`;

    const made = await page.request.post("/v1/roles", { headers: SPA_HEADERS, data: { name, label } });
    expect(made.status(), await made.text()).toBe(200);

    try {
      await gotoRoute(page, "assets", "Assets");
      await accessModeOn(page);
      const key = page.getByRole("button", { name: "Manage access: Assets" }).first();
      await expect(key).toBeVisible({ timeout: 30_000 });
      // Nothing denied yet: the key is the ordinary one, and its tooltip says only what it manages.
      await expect(key).toHaveAttribute("title", /^Manage access: Assets$/);

      // A deny, for a role nobody holds - it changes nobody's access and is still a deny in force on the
      // target, which is exactly the thing the tint exists to surface.
      const denied = await page.request.post("/v1/access-rules", {
        headers: SPA_HEADERS,
        data: { subject_kind: "role", subject: name, collection: "assets", scope: "all", effect: "deny" },
      });
      expect(denied.status(), await denied.text()).toBe(200);

      // The tint is drawn from a cache the provider loads when the mode turns on and refreshes when the
      // modal closes, so the mode is turned off and on again rather than the page reloaded - which is what a
      // person would do, and the path that would break if the cache were never invalidated.
      await accessModeOff(page);
      await accessModeOn(page);
      await expect(key).toHaveAttribute("title", /an explicit deny is in effect here/, { timeout: 30_000 });

      // And the modal names WHICH deny, so the allow somebody is about to write is not authored dead.
      await key.click();
      const editor = page.getByRole("dialog");
      await expect(editor.getByText("A deny is in force here", { exact: false })).toBeVisible({ timeout: 30_000 });
      await expect(editor.getByText(label, { exact: false }).first()).toBeVisible();
      await page.keyboard.press("Escape");

      // Taken away, the tint goes with it - a red key that stays red after the lockout is gone is worse than
      // no red key at all.
      await sweep(page, name);
      await accessModeOff(page);
      await accessModeOn(page);
      await expect(key).toHaveAttribute("title", /^Manage access: Assets$/, { timeout: 30_000 });
    } finally {
      await sweep(page, name);
      await page.request.delete(`/v1/roles/${name}`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
  });

  test("a preset authors the whole Everyone bundle in one press", async ({ as }) => {
    test.setTimeout(300_000);
    const page = await as("super");

    try {
      // The org-wide grid's key is the way to a plain collection target for a collection with no page of its
      // own - which is where the presets live.
      await gotoRoute(page, "settings/permissions", "Permissions");
      await page.getByRole("searchbox", { name: "Filter collections…" }).fill("Pay grades");
      const row = page.locator("tbody tr").filter({ hasText: "Pay grades" }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.locator("td").nth(1).getByRole("button").click();

      const editor = page.getByRole("dialog");
      await expect(editor.getByRole("heading", { name: /Manage access · Pay grades/ })).toBeVisible({ timeout: 30_000 });
      // Before: the summary line has read the rules (HR and payroll hold pay grades in the seed) and says
      // nothing of everyone - which is the part the preset changes.
      await expect(editor.getByText(/(role|roles|person|people) can see this|Nobody but full admins can see this/)).toBeVisible({ timeout: 30_000 });
      await expect(editor.getByText("Everyone can see this", { exact: true })).toHaveCount(0);

      await editor.getByRole("button", { name: "Everyone can view" }).click();
      const confirm = page.getByRole("dialog").filter({ hasText: "Open pay grades to everyone?" });
      await expect(confirm).toBeVisible({ timeout: 30_000 });
      // A preset ADDS; it never quietly repeals what is already there, and it says so before it runs.
      await expect(confirm.getByText("Existing rules stay untouched", { exact: false })).toBeVisible();
      await confirm.getByRole("button", { name: "Apply" }).click();
      await expect(toast(page, "Preset applied")).toBeVisible({ timeout: 30_000 });

      // The summary line is the modal's one-line answer to "who can do this?", and it has changed.
      await expect(editor.getByText("Everyone can", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

      const rule = (await accessRules(page)).find((r) => r.subject === "everyone" && r.collection === "pay-grades" && r.scope === "all");
      expect(rule?.level, "the preset wrote no org-wide read for everyone").toBe("read");

      // Undone through the Roles tab, which is where the preset's own rule now shows up as an ordinary row -
      // a preset that could not be read back and reversed like any other grant would be a trapdoor.
      await editor.getByRole("tab", { name: /^Roles/ }).click();
      // `has:` page-rooted, not re-scoped from `editor` - a has-locator carries its whole ancestor chain into
      // the containment check, so `editor.getByRole(...)` would ask each row to contain another dialog
      // nested inside it (it never will) and silently match nothing.
      const everyoneRow = editor.locator("div").filter({ hasText: "all signed-in users" }).filter({ has: page.getByRole("combobox") }).last();
      await expect(everyoneRow).toBeVisible({ timeout: 30_000 });
      const level = everyoneRow.getByRole("combobox").last();
      await expect(level).toContainText("read");
      await level.click();
      await page.getByRole("option", { name: /^none$/i }).click();
      await expect(level).toContainText("none", { timeout: 30_000 });
      expect((await accessRules(page)).find((r) => r.subject === "everyone" && r.collection === "pay-grades")).toBeUndefined();
    } finally {
      for (const rule of await accessRules(page)) {
        if (rule.subject === "everyone" && rule.collection === "pay-grades") {
          await page.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
        }
      }
    }
  });
});

async function accessModeOn(page: Page) {
  // By its title, not its accessible name: the trigger is an avatar, and with no photo seeded its name is
  // the initials the fallback draws.
  await page.locator('header button[title^="Sam Super"]').click();
  await page.getByRole("menuitem", { name: /Access management/ }).click();
}

async function accessModeOff(page: Page) {
  await page.getByRole("button", { name: "Turn off access mode" }).click();
  await expect(page.getByRole("button", { name: /^Manage access: / })).toHaveCount(0);
}

/** Every rule this test authored for `subject`, gone. */
async function sweep(page: Page, subject: string) {
  for (const rule of await accessRules(page)) {
    if (rule.subject === subject) await page.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
  }
}
