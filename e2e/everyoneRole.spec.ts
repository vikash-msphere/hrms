import {
  SPA_HEADERS,
  accessRules,
  allowConsoleErrors,
  capabilitiesOf,
  gotoRoute,
  toast,
  test,
  expect,
} from "./fixtures";

// The "allow everyone" primitive.
//
// `everyone` is a reserved subject, not a role anybody holds: it is a real `roles` row so the ACL UI can
// target it, users.ts refuses to assign it, and the engine unions its rules into every authenticated caller
// at decide time - except super, who is exempt so an `everyone` deny can never lock out the break-glass
// identity (src/domain/grants.ts). It is the single widest thing an admin can do in this app in one press,
// and it has never been pressed in a browser: `test/` owns what the primitive MEANS, and the UI half - that
// the row is unmistakable, that granting it there actually widens a bystander's authority, and that taking it
// back narrows it again - is only observable with two browsers open.
//
// The target is `letter-templates`: a collection with no sidebar entry of its own (so a grant cannot change
// what any other spec's nav or route assertions see mid-run) and one no seeded employee holds.
test("granting the everyone row widens a bystander's access, and revoking it narrows again", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const bystander = await as("employee");
  // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.) - a genuine access mismatch still fails via this test's own
  // assertions below.
  allowConsoleErrors(admin, /status of 503/i);
  allowConsoleErrors(bystander, /status of 503/i);

  const before = await capabilitiesOf(bystander);
  expect(before, "the seed already grants this - pick a collection nobody holds").not.toContain("letter-templates.read");

  try {
    await gotoRoute(admin, "settings/roles", "Roles");
    const row = admin.locator("tbody tr").filter({ hasText: "Everyone" }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // It is a rule subject, never an assignment: the identifier is there to be granted, and nobody is IN it.
    await expect(row).toContainText("everyone");
    await row.getByRole("button", { name: "Role actions" }).click();
    await admin.getByRole("menuitem", { name: "Manage permissions" }).click();

    const sheet = admin.getByRole("dialog").filter({ hasText: "Permissions · Everyone" });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await sheet.getByPlaceholder("Filter collections…").fill("Letter templates");
    // `has:` page-rooted, not re-scoped from `sheet` - a has-locator carries its whole ancestor chain into
    // the containment check, so `sheet.getByRole(...)` would ask each row to contain another dialog nested
    // inside it (it never will) and silently match nothing.
    const cell = sheet
      .locator("div")
      .filter({ hasText: /^Letter templates/ })
      .filter({ has: admin.getByRole("combobox") })
      .last();
    await expect(cell).toBeVisible({ timeout: 30_000 });
    const level = cell.getByRole("combobox");
    await expect(level).toContainText("none");

    await level.click();
    await admin.getByRole("option", { name: /^read$/i }).click();
    await expect(toast(admin, "Updated Letter templates")).toBeVisible({ timeout: 30_000 });
    await expect(level).toContainText("read");

    // One rule, whose subject is the reserved name rather than any real role.
    const rule = (await accessRules(admin)).find((r) => r.subject === "everyone" && r.collection === "letter-templates");
    expect(rule?.subject_kind).toBe("role");
    expect(rule?.level).toBe("read");

    // The bystander never asked for anything and was never named: this is the whole point of the primitive,
    // and the reason it is worth a test that watches somebody else's authority change. Polled, not read once:
    // this is a genuinely separate session's own fresh GET (capabilitiesOf bypasses any client cache), so a
    // pass here is not a rendering race - but the grant computation itself has occasionally still answered
    // for a beat with what was true just before this press, under load.
    await expect.poll(() => capabilitiesOf(bystander), { timeout: 15_000 }).toContain("letter-templates.read");

    // Back off again - the direction that has to work, or an org cannot undo its widest press.
    await level.click();
    await admin.getByRole("option", { name: /^none$/i }).click();
    const confirm = admin.getByRole("dialog").filter({ hasText: "Take away Everyone's access to Letter templates?" });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole("button", { name: "Remove access" }).click();
    await expect(toast(admin, "Updated Letter templates")).toBeVisible({ timeout: 30_000 });
    await expect(level).toContainText("none");

    await expect.poll(() => capabilitiesOf(bystander), { timeout: 15_000 }).not.toContain("letter-templates.read");
  } finally {
    for (const rule of await accessRules(admin)) {
      if (rule.subject === "everyone" && rule.collection === "letter-templates") {
        await admin.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
      }
    }
  }
});
