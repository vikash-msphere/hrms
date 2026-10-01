import { SPA_HEADERS, accessRules, allowConsoleErrors, gotoRoute, toast, test, expect } from "./fixtures";

// Changing a rule in place, from Settings › Permissions › All rules.
//
// The grid sets org-wide levels and nothing else; the rules list is where every rule is read, whatever its
// scope, field, method or expiry, and the pencil on a row is how one of those is changed. The API has no
// in-place rewrite of a grant, so an edit is the old rule's removal plus the new rule's create - which makes
// the claim to check the outcome on the wire: one rule left, carrying what the dialog said it would, and the
// old row gone rather than sitting beside it.
//
// A throwaway role nobody holds, on `letter-templates` (no sidebar entry), so the rule moves nobody's access
// and no other spec's nav.
test("a rule is edited from the rules list: new level and expiry, one rule left", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  // A new level keeps the rule's pattern, so the edit's create-first dry run is answered 409 by the very rule it
  // replaces (cloneRules.ts replaceAccessRule). The browser logs that refusal; here it is the expected answer.
  allowConsoleErrors(page, /status of 409\b.*\/v1\/access-rules\b/i);
  const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
  const name = `e2e_edit_rule_${stamp}`;
  const label = `E2E Edit Rule ${stamp}`;

  const made = await page.request.post("/v1/roles", { headers: SPA_HEADERS, data: { name, label } });
  expect(made.status(), await made.text()).toBe(200);

  try {
    const res = await page.request.post("/v1/access-rules", {
      headers: SPA_HEADERS,
      data: { subject_kind: "role", subject: name, collection: "letter-templates", scope: "all", level: "read" },
    });
    expect(res.status(), await res.text()).toBe(200);
    const original = ((await res.json()) as { path: string }).path;

    await gotoRoute(page, "settings/permissions", "Permissions");
    await page.getByRole("button", { name: "All rules", exact: true }).click();
    // The org holds hundreds of rules and other specs write more while this runs, so the row is reached
    // through the Rule column's own filter rather than hoped for on the first page.
    await page.getByRole("button", { name: "Filter by rule" }).first().click();
    await page.getByPlaceholder("Search rule").fill(label);
    await page.keyboard.press("Escape");
    const row = page.locator("tbody tr").filter({ hasText: label });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await row.getByRole("button", { name: "Edit this rule" }).click();

    const dialog = page.getByRole("dialog").filter({ hasText: "Edit rule" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // Opened on the rule as it stands: nothing to save until something is changed. A form that read the rule
    // back differently from how it is stored would offer a Save here, and pressing it would rewrite the rule.
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(dialog.getByText("Nothing has changed yet.")).toBeVisible();

    await dialog.getByRole("combobox", { name: "Level" }).click();
    await page.getByRole("option", { name: "write", exact: true }).click();
    // Any day well ahead works: the picker's floor is tomorrow wherever the browser is.
    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await dialog.getByLabel("Expires").fill(day);
    await expect(dialog.locator("p").filter({ hasText: "After saving:" })).toContainText("write access");

    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(toast(page, "Rule updated")).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toHaveCount(0);

    const mine = (await accessRules(page)).filter((r) => r.subject === name);
    expect(mine, "an edit must leave exactly one rule, not the old one beside the new").toHaveLength(1);
    expect(mine[0]!.level).toBe("write");
    expect(mine[0]!.scope).toBe("all");
    expect(mine[0]!.expire_time, "the expiry set in the dialog did not reach the rule").toBeTruthy();
    expect(mine[0]!.path).not.toBe(original);

    // And the list reads the replacement back, under the same filter.
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).toContainText("write access");
  } finally {
    for (const rule of await accessRules(page)) {
      if (rule.subject === name) await page.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
    // deleteRole drops the role's own access-rules rows and takes no If-Match: roles are a bespoke router.
    await page.request.delete(`/v1/roles/${name}`, { headers: SPA_HEADERS }).catch(() => undefined);
  }
});
