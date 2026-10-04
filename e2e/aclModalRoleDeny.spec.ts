import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// The per-object access editor itself, not just its affordance.
//
// `accessMode.spec.ts` proves the key icon appears and opens "Manage access · Vendors" - and stops there,
// never pressing a single control inside. `test/webAccessCoverage.test.ts` only proves the affordance exists
// IN THE SOURCE. So the whole rule-authoring surface of this modal - the one the app's own comment calls "the
// most consequential surface in the app" - has never actually written an access-rules row from a browser.
// This presses the sharpest one: a role-level DENY, which (unlike an allow) asks first and always wins over
// any grant. A throwaway role, never a seeded one, so nothing else's access is put at risk by this test.
test("a role is denied access to a collection through the Manage access editor, and the denial reads back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const label = `E2E Deny Role ${Date.now() % 100000}`;
  const name = `e2e_deny_${Date.now() % 100000}`;

  const madeRole = await page.request.post("/v1/roles", { headers: SPA_HEADERS, data: { name, label } });
  expect(madeRole.status(), await madeRole.text()).toBe(200);

  try {
    await gotoRoute(page, "vendors", "Vendors");
    await page.locator('header button[title^="Sam Super"]').click();
    await page.getByRole("menuitem", { name: /Access management/ }).click();
    await page.getByRole("button", { name: "Manage access: Vendors" }).first().click();

    const editor = page.getByRole("dialog");
    await expect(editor.getByRole("heading", { name: /Manage access · Vendors/ })).toBeVisible();
    await editor.getByRole("tab", { name: /^Roles/ }).click();

    // Found by its own unique label, not by position - the role list is real seeded roles plus this one.
    const filter = editor.getByRole("searchbox", { name: "Filter roles…" });
    if (await filter.count()) await filter.fill(label);
    // `has:` must be page-rooted, not re-scoped from `editor` - a has-locator carries its WHOLE chain into the
    // containment check, so `editor.getByRole(...)` here would ask each row to contain another `role=dialog`
    // nested inside it (it never will) and silently match nothing.
    const row = editor.locator("div").filter({ hasText: label }).filter({ has: page.getByRole("combobox") }).last();
    await expect(row, "the new role never showed up in the role list").toBeVisible({ timeout: 30_000 });

    const level = row.getByRole("combobox").last();
    await expect(level).toContainText(/none/i);
    await level.click();
    await page.getByRole("option", { name: /^deny$/i }).click();

    const confirm = page.getByRole("dialog").filter({ hasText: `Deny ${label} here?` });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole("button", { name: "Deny", exact: true }).click();
    // The toast lives in the shared Notifications region, not inside the dialog.
    await expect(toast(page, `Updated ${label}`)).toBeVisible({ timeout: 30_000 });
    await expect(level).toContainText(/deny/i);

    // On the wire, not just in the widget: a real access-rules row, and it always wins regardless of any
    // allow that might otherwise apply.
    const rules = await page.request.get("/v1/access-rules?page_size=200");
    const { results = [] } = (await rules.json()) as { results?: { subject?: string; subject_kind?: string; collection?: string; effect?: string }[] };
    const rule = results.find((r) => r.subject_kind === "role" && r.subject === name && r.collection === "vendors");
    expect(rule?.effect, "no deny rule was written for the role").toBe("deny");

    // Cleaned up through the same control it was set with - "none" removes the rule outright, no confirm.
    await level.click();
    await page.getByRole("option", { name: /^none$/i }).click();
    await expect(level).toContainText(/none/i);
    // The explicit close button, not Escape: this dialog wraps a history-back close (dialog.tsx's
    // `useHistoryClose`) rather than relying on Radix's default Escape handling.
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole("button", { name: "Turn off access mode" }).click();
  } finally {
    // deleteRole (src/services/roles.ts) drops the role's own access-rules rows itself and takes no If-Match
    // - roles are a bespoke router, not the generic collectionRoutes pattern the rest of the wire uses.
    await page.request.delete(`/v1/roles/${name}`, { headers: SPA_HEADERS }).catch(() => undefined);
  }
});
