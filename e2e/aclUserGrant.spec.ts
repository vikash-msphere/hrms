import type { Locator, Page } from "@playwright/test";
import {
  SPA_HEADERS,
  accessRules,
  allowConsoleErrors,
  gotoRoute,
  makeThrowawayPerson,
  retireThrowawayPerson,
  toast,
  userPath,
  test,
  expect,
} from "./fixtures";

// Granting ONE PERSON access, from the modal, and watching them get it.
//
// `aclModalRoleDeny` drives the Roles tab. The Users tab is the other half of the same modal and the one an
// admin reaches for most often ("give this contractor the vendor list"), and until now nothing has pressed a
// single control on it: not the person picker, not the level, not the expiry, not the grant sentence, not the
// trash. Nor has anything in the suite proved the end of the story - that a rule authored in a browser
// actually changes what the granted person's own browser is served. That is the whole point of the surface,
// and it is the one thing neither the server suite (which owns what a rule MEANS) nor a source scan can see.
//
// Everything happens to a person this spec provisions, never a seeded login: an org-wide rule on one of the
// five would change what another worker's spec is being asked to prove, mid-run.
test.describe("per-user access rules", () => {
  test("a person is granted a collection from the Users tab, and their own browser gets it", async ({ as }) => {
    test.setTimeout(300_000);
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "Grant");
    const subject = await userPath(admin, person.email);

    // Their browser, before anything is granted: the wall, and the 403 behind it that the browser logs.
    const theirs = await as({ email: person.email });
    allowConsoleErrors(theirs, /status of 403|Failed to load resource/i);
    await gotoRoute(theirs, "vendors");
    await expect(theirs.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });

    try {
      const editor = await openVendorAccess(admin);

      // The ground truth panel, asked BEFORE the grant: it names the person and reports no rule reaching
      // them. (`via …` is only printed when some rule actually admits them.)
      await editor.getByRole("button", { name: "Check a person's access" }).click();
      await pick(admin, editor, "Pick a person…", person.email);
      await expect(editor.getByText(person.name, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
      await expect(editor.getByText("via an org-wide rule")).toHaveCount(0);

      // The grant itself. The sentence under the form is the promise the engine is about to keep, so it is
      // read before the press rather than after.
      await editor.getByRole("tab", { name: /^Users/ }).click();
      await pick(admin, editor, "Search people…", person.email);
      await expect(editor.getByText(person.email, { exact: false }).first()).toBeVisible();
      await expect(editor.getByText("Grant:")).toBeVisible();
      await editor.getByRole("button", { name: /^Add$/ }).click();
      await expect(toast(admin, "1 person updated")).toBeVisible({ timeout: 30_000 });

      // The panel re-asks the engine on its own once the rules under it change - a stale verdict here would
      // read as confirmation that the edit did nothing.
      await expect(editor.getByText("via an org-wide rule")).toBeVisible({ timeout: 30_000 });
      // And the one-line summary at the top now counts people rather than saying nobody holds this. (The
      // count itself is not pinned: another spec's throwaway grant on the same collection may be alive in
      // the same second, and this line is about the summary reacting at all.)
      await expect(editor.getByText(/\d+ (person|people) can/)).toBeVisible();

      // On the wire: a real row, for this person, on this collection, at the level that was picked.
      const rule = (await accessRules(admin)).find((r) => r.subject === subject && r.collection === "vendors");
      expect(rule, "no access-rules row was written for the person").toBeTruthy();
      expect(rule?.effect ?? "allow").toBe("allow");
      expect(rule?.level).toBe("read");

      // The end of the story: their browser, reloaded, is served the page instead of the wall. A real reload
      // is required - `theirs` already loaded vendors once above, and re-navigating to the SAME route
      // is a same-document jump the SPA's cached capabilities survive; only a genuine reload re-fetches them.
      await theirs.reload();
      await gotoRoute(theirs, "vendors", "Vendors");
      await expect(theirs.getByText("You don't have access to this")).toHaveCount(0);
      // Read, not write: the create button stays hidden, because a read grant is not permission to add one.
      await expect(theirs.getByRole("button", { name: "New vendor" })).toHaveCount(0);
      // The navigation agrees with the page. Vendors is a TAB of the Expenses workspace (which this person
      // could already open, for their own expenses), so the honest question is whether the tab appeared -
      // a page reachable only by typing its URL is a page nobody finds.
      await expect(theirs.locator('a[href="/vendors"]').first()).toBeVisible({ timeout: 30_000 });

      // Taken away again through the control that authored it, confirm and all.
      await editor.getByRole("button", { name: "Remove this access rule" }).first().click();
      const confirm = admin.getByRole("dialog").filter({ hasText: "Remove this access rule?" });
      await expect(confirm).toBeVisible({ timeout: 15_000 });
      await confirm.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(toast(admin, "Access rule removed")).toBeVisible({ timeout: 30_000 });
      // This person's row is gone from the list. Not "the list is empty": another spec's throwaway grant on
      // the same collection can be alive in the same second, and asserting on the whole list would make this
      // test fail for something that is not its business.
      //
      // `fetchAllAccessRules()` pages through EVERY access-rules row org-wide, unfiltered - on a busy lane
      // with many other specs concurrently writing that same collection, a page boundary can shift between
      // requests, and the editor's own single post-delete `reload()` can land on a multi-page read that still
      // carries this now-deleted row on a later page. Waiting longer does not help (nothing re-issues that
      // fetch on its own) - a real page reload (not Escape, which has proven unreliable at actually closing
      // this dialog under load elsewhere in the suite too) forces a genuinely fresh one, retried in case that
      // one is unlucky too.
      await expect(async () => {
        await admin.reload();
        await openVendorAccess(admin);
        await editor.getByRole("tab", { name: /^Users/ }).click();
        await expect(editor.getByText(person.email, { exact: false })).toHaveCount(0, { timeout: 5_000 });
      }).toPass({ timeout: 30_000 });

      // And the access goes with it. Same reload requirement as above - re-navigating alone would still
      // show the page from the SPA's cached capabilities.
      await theirs.reload();
      await gotoRoute(theirs, "vendors");
      await expect(theirs.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
    } finally {
      await sweepRules(admin, subject);
      await retireThrowawayPerson(admin, person.path);
    }
  });

  test("a per-user deny is authored, announced, and beats the allow beside it", async ({ as }) => {
    test.setTimeout(300_000);
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "Deny");
    const subject = await userPath(admin, person.email);

    try {
      // An allow first, written on the wire so the UI half of this test is only about the DENY.
      const made = await admin.request.post("/v1/access-rules", {
        headers: SPA_HEADERS,
        data: { subject_kind: "user", subject, collection: "vendors", scope: "all", level: "read", effect: "allow" },
      });
      expect(made.status(), await made.text()).toBe(200);

      const theirs = await as({ email: person.email });
      allowConsoleErrors(theirs, /status of 403|Failed to load resource/i);
      await gotoRoute(theirs, "vendors", "Vendors");

      const editor = await openVendorAccess(admin);
      await editor.getByRole("tab", { name: /^Users/ }).click();
      await pick(admin, editor, "Search people…", person.email);
      // The level select: the only `role=combobox` on this tab (the person picker is a plain button, and a
      // rule row carries badges rather than controls).
      await editor.getByRole("combobox").click();
      await admin.getByRole("option", { name: /^deny$/i }).click();
      // A deny needs no expiry - it is not a temporary favour - so the form drops the date field.
      await expect(editor.locator('input[type="date"]')).toHaveCount(0);
      await editor.getByRole("button", { name: /^Add$/ }).click();
      await expect(toast(admin, "1 person updated")).toBeVisible({ timeout: 30_000 });

      // The modal says a deny is in force and that the allow beside it is now inert - the sentence that stops
      // an admin from authoring a second dead allow while wondering why the first did nothing.
      await expect(editor.getByText("A deny is in force here", { exact: false })).toBeVisible({ timeout: 30_000 });
      await expect(editor.getByText("A deny always wins", { exact: false }).first()).toBeVisible();

      // Two rules on the wire, and the engine answers with the deny.
      const mine = (await accessRules(admin)).filter((r) => r.subject === subject && r.collection === "vendors");
      expect(mine.map((r) => r.effect).sort()).toEqual(["allow", "deny"]);

      // Their browser loses the DATA it had a moment ago - NOT the route wall. Capabilities (what makes the
      // Vendors tab/page reachable at all) are a coarser, role-level thing this person's initial allow
      // already satisfied; the deny added here overrides the fine-grained access-rules check underneath it,
      // so the page still renders but its own fetch now 403s. Confirmed on the wire directly (bypassing the
      // UI): a plain GET here comes back 403, same as the DataState error the page itself shows.
      const denied = await theirs.request.get("/v1/vendors");
      expect(denied.status(), "the deny never reached the actual data fetch").toBe(403);
      await theirs.reload();
      await gotoRoute(theirs, "vendors", "Vendors");
      await expect(theirs.getByText("You do not have permission to perform this action")).toBeVisible({ timeout: 30_000 });
    } finally {
      await sweepRules(admin, subject);
      await retireThrowawayPerson(admin, person.path);
    }
  });
});

/** Turn access mode on and open the Vendors collection's rule editor. */
async function openVendorAccess(admin: Page) {
  await gotoRoute(admin, "vendors", "Vendors");
  // By its title, not its accessible name: the trigger is an avatar, and with no photo seeded its name is
  // the initials the fallback draws.
  await admin.locator('header button[title^="Sam Super"]').click();
  await admin.getByRole("menuitem", { name: /Access management/ }).click();
  await admin.getByRole("button", { name: "Manage access: Vendors" }).first().click();
  const editor = admin.getByRole("dialog");
  await expect(editor.getByRole("heading", { name: /Manage access · Vendors/ })).toBeVisible({ timeout: 30_000 });
  return editor;
}

/**
 * Pick somebody in one of the modal's comboboxes, by the trigger's own placeholder.
 *
 * Filter-then-Enter rather than clicking the row: the list is every login in the org, and the popover is
 * anchored inside a dialog that is still settling as the lists behind it paginate - the keyboard path takes
 * the highlighted match and does not care where it is on screen.
 */
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

/** Every rule this spec's subject ever got, gone - whatever the test managed to author before failing. */
async function sweepRules(admin: Page, subject: string) {
  for (const rule of await accessRules(admin)) {
    if (rule.subject === subject) {
      await admin.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
  }
}
