import type { Locator, Page } from "@playwright/test";
import {
  SPA_HEADERS,
  accessRules,
  allowConsoleErrors,
  capabilitiesOf,
  gotoRoute,
  makeThrowawayPerson,
  retireThrowawayPerson,
  toast,
  userPath,
  test,
  expect,
} from "./fixtures";

// Granting ONE CUSTOM METHOD, and watching the button it belongs to appear.
//
// The read/write/full ladder is only half of the model. The other half is the custom methods - `batchCreate`,
// `printTag`, `approve`, `publish` - which are denied unless explicitly allowed, are granted through a
// different path in the modal (the method chips, which drill the whole editor into one verb), and arrive as a
// different shape of capability (`assets.batchCreate`, matched by `hasCapability` through rules that do not
// apply to the level ladder at all). Nothing in the suite has ever pressed a method chip, and nothing has
// ever followed one of these grants to the button it is supposed to light up.
//
// That last step is the point: a verb grant that writes a correct row and lights nothing is indistinguishable
// from a broken grant to the person who asked for it. `assets.batchCreate` is the honest case to prove it on,
// because its button ("Add many") renders unconditionally for a holder - so its absence is the gate and
// nothing else.
test("a custom method is granted to one person, and their button appears", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const person = await makeThrowawayPerson(admin, "Verb");
  const subject = await userPath(admin, person.email);

  try {
    // Reading the inventory is a level grant and not what this spec is about, so it is written on the wire.
    // Without it the person meets the route wall and there is no page to look for a button on.
    const read = await admin.request.post("/v1/access-rules", {
      headers: SPA_HEADERS,
      data: { subject_kind: "user", subject, collection: "assets", scope: "all", level: "read", effect: "allow" },
    });
    expect(read.status(), await read.text()).toBe(200);

    const theirs = await as({ email: person.email });
    allowConsoleErrors(theirs, /status of 403|Failed to load resource/i);
    await gotoRoute(theirs, "assets", "Assets");
    // Read is not permission to run a method: the method's button is not on their page, and the capability
    // is not in their set either.
    await expect(theirs.getByRole("button", { name: "Add many", exact: true })).toHaveCount(0);
    expect(await capabilitiesOf(theirs)).not.toContain("assets.batchCreate");

    // The admin drills the editor into that one method.
    await gotoRoute(admin, "assets", "Assets");
    await admin.locator('header button[title^="Sam Super"]').click();
    await admin.getByRole("menuitem", { name: /Access management/ }).click();
    await admin.getByRole("button", { name: "Manage access: Assets" }).first().click();
    const editor = admin.getByRole("dialog");
    await expect(editor.getByRole("heading", { name: /Manage access · Assets/ })).toBeVisible({ timeout: 30_000 });

    // The chips are the method vocabulary, in the words an admin reads rather than the wire's - and the
    // "All methods" chip beside them is the wildcard rule, which must not be the only way in.
    await expect(editor.getByRole("button", { name: "All methods" })).toBeVisible();
    await editor.getByRole("button", { name: "Add many at once" }).click();
    // Drilled in, the whole modal is about this one method: it says so, and it offers the way back.
    await expect(editor.getByText("batchCreate", { exact: false }).first()).toBeVisible();
    await expect(editor.getByRole("button", { name: "Back to standard access" })).toBeVisible();

    // This sentence lives in the Users tabpanel's own intro paragraph, not on whichever tab happened to be
    // active when the modal was drilled into the method - so it is checked after switching there, not before
    // (an inactive Radix tabpanel is present in the DOM but never counts as "visible").
    await editor.getByRole("tab", { name: /^Users/ }).click();
    await expect(editor.getByText("A custom method is denied unless explicitly allowed", { exact: false })).toBeVisible();
    await pick(admin, editor, "Search people…", person.email);
    await editor.getByRole("button", { name: /^Add$/ }).click();
    await expect(toast(admin, "1 person updated")).toBeVisible({ timeout: 30_000 });

    // On the wire this is a VERB rule, not a level one - the distinction the whole model rests on.
    const rule = (await accessRules(admin)).find((r) => r.subject === subject && r.verb === "batchCreate");
    expect(rule, "no verb rule was written").toBeTruthy();
    expect(rule?.collection).toBe("assets");
    expect(rule?.effect).toBe("allow");
    expect(rule?.level ?? null).toBeNull();

    // Their side: the capability arrives, and with it the button.
    expect(await capabilitiesOf(theirs)).toContain("assets.batchCreate");
    // A real reload, not just a re-navigation: `theirs` already loaded assets once above, and the SPA's
    // cached capabilities survive a same-route re-navigation - only a genuine reload re-fetches them.
    await theirs.reload();
    await gotoRoute(theirs, "assets", "Assets");
    // `.first()`: the toolbar button and a per-row "Add many" both match once assets exist to show rows for.
    await expect(theirs.getByRole("button", { name: "Add many", exact: true }).first()).toBeVisible({ timeout: 30_000 });
    // One method, not the drawer: creating an asset outright is still the write level they were never given.
    await expect(theirs.getByRole("button", { name: "Add asset", exact: true })).toHaveCount(0);
  } finally {
    for (const rule of await accessRules(admin)) {
      if (rule.subject === subject) {
        await admin.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
      }
    }
    await retireThrowawayPerson(admin, person.path);
  }
});

/** Pick somebody in one of the modal's comboboxes: filter, then Enter (see aclUserGrant for why). */
async function pick(page: Page, scope: Locator, trigger: string, query: string) {
  await scope.getByRole("button", { name: trigger }).click();
  await page.getByPlaceholder("Search…").fill(query);
  // Combobox.tsx picks `filtered[active]` on Enter - a candidate list built from a fetch this popover only
  // starts once it opens, not from what is already on screen. Enter fired before that fetch lands finds
  // `filtered` still empty, selects nothing, and leaves the search box open forever (nothing here ever
  // retries the press) - waited on the one thing that proves a candidate exists to choose.
  await expect(page.locator("[data-idx]").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Search…")).toHaveCount(0, { timeout: 15_000 });
}
