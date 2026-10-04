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

// One person's whole permission sheet, from the Users panel.
//
// There are two ways into the same engine, and they are used by different people at different moments: the
// in-context key icon (one collection, wherever you happen to be standing - `aclUserGrant` covers that), and
// this one - "Manage permissions" on a row in Settings › Users, which opens every collection at once for one
// person. It is where an admin goes when the question is "what can THIS person do?", and it is untested end
// to end: the collection filter, the level cell, the inherited-from-role line beside it, the confirm that
// only appears when access is being taken AWAY, and the "All rules" tab that shows the row the cell wrote.
//
// The grid is also the surface most likely to lie quietly: a cell that saves nothing, or one that reads back
// the role's level as if it were an exception, both look exactly like a working grid.
test("a person's access is granted and revoked from the Users permission sheet", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const person = await makeThrowawayPerson(admin, "Sheet");
  const subject = await userPath(admin, person.email);

  const theirs = await as({ email: person.email });
  allowConsoleErrors(theirs, /status of 403|Failed to load resource/i);

  try {
    await gotoRoute(theirs, "vendors");
    await expect(theirs.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });

    await gotoRoute(admin, "settings/users", "Users");
    const row = admin.locator("tbody tr").filter({ hasText: person.email });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "User actions" }).click();
    await admin.getByRole("menuitem", { name: "Manage permissions" }).click();

    const sheet = admin.getByRole("dialog").filter({ hasText: `Permissions · ${person.email}` });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    // What this dialog IS, said on it: exceptions on top of a role, and a deny that beats both.
    await expect(sheet.getByText("Per-user access (exceptions layered on the user's role)", { exact: false })).toBeVisible();
    await expect(sheet.getByText(/Role: Employee/)).toBeVisible();

    // Sixty collections is a scanning problem, so the grid is filtered rather than scrolled.
    await sheet.getByRole("searchbox", { name: "Filter collections…" }).fill("Vendors");
    // `has:` page-rooted, not re-scoped from `sheet` - a has-locator carries its whole ancestor chain into
    // the containment check, so `sheet.getByRole(...)` would ask each row to contain another dialog nested
    // inside it (it never will) and silently match nothing.
    const cell = sheet
      .locator("div")
      .filter({ hasText: /^Vendors/ })
      .filter({ has: admin.getByRole("combobox") })
      .last();
    await expect(cell).toBeVisible({ timeout: 30_000 });
    const level = cell.getByRole("combobox");
    await expect(level).toContainText("none");

    // Granting read is the ordinary direction, so it passes straight through without a confirm - a matrix
    // that asked twice per cell would teach an admin to dismiss the asking.
    await level.click();
    await admin.getByRole("option", { name: /^read$/i }).click();
    await expect(toast(admin, "Updated Vendors")).toBeVisible({ timeout: 30_000 });
    await expect(level).toContainText("read");

    // The same rule, seen the other way: the fine tab lists every rule this person has, whatever its scope.
    await sheet.getByRole("tab", { name: "All rules" }).click();
    await expect(sheet.getByText("vendors", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    // On the wire, and in their browser.
    const rule = (await accessRules(admin)).find((r) => r.subject === subject && r.collection === "vendors");
    expect(rule?.level, "the grid cell wrote no rule").toBe("read");
    await theirs.reload();
    await gotoRoute(theirs, "vendors", "Vendors");
    await expect(theirs.getByText("You don't have access to this")).toHaveCount(0);

    // Taking it away is the direction that surprises people, so this one DOES ask - and says what they have
    // now and where the rest of their access comes from.
    await sheet.getByRole("tab", { name: "By collection" }).click();
    await level.click();
    await admin.getByRole("option", { name: /^none$/i }).click();
    const confirm = admin.getByRole("dialog").filter({ hasText: `Take away ${person.email}'s access to Vendors?` });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText("They currently have read", { exact: false })).toBeVisible();
    await confirm.getByRole("button", { name: "Remove access" }).click();
    // Not the toast: the grant above raised the same "Updated Vendors", and it can still be on screen, so it
    // proves nothing about this write. The cell is disabled from the press until the delete AND the re-read
    // have landed, and the level it shows while saving is the one asked for - so enabled-and-none is the
    // server's answer, and the wire read is polled as well.
    await expect(level).toBeEnabled({ timeout: 30_000 });
    await expect(level).toContainText("none");

    await expect
      .poll(async () => (await accessRules(admin)).find((r) => r.subject === subject && r.collection === "vendors"), { timeout: 30_000 })
      .toBeUndefined();
    await theirs.reload();
    await gotoRoute(theirs, "vendors");
    await expect(theirs.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  } finally {
    for (const rule of await accessRules(admin)) {
      if (rule.subject === subject) {
        await admin.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
      }
    }
    await retireThrowawayPerson(admin, person.path);
  }
});
