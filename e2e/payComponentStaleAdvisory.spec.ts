import {
  SPA_HEADERS,
  accessRules,
  gotoRoute,
  makeThrowawayPerson,
  purge,
  retireThrowawayPerson,
  test,
  expect,
  toast,
  userPath,
} from "./fixtures";

// "This changes the CTC build-up, go ask Payroll" - the half of `useSplitStaleness` a caller who cannot
// re-apply gets instead of the banner. Editing a pay component can move every employee's cached basic /
// Special-Allowance split, and the old code only ever surfaced that to whoever COULD fix it - a cost-shifting
// edit by somebody who holds `pay-components.write` but not `compensation:reapplySplit` used to go completely
// silent. It fires on every save regardless of whether anything actually moved (the dry-run is Payroll's to
// run), which is what makes it safe to prove without staging real staleness: a throwaway component saved and
// removed is enough.
//
// No SEEDED role is that caller any more - pay components are payroll's, and payroll also holds the re-apply
// verb (bootstrap/authz/roles/payroll_admin.json) - but an org can grant the catalogue to someone else in
// Access Management, and that person is exactly who the advisory is for. So the spec makes one: a throwaway
// person granted pay-components write and nothing of compensation.
test("a pay-component editor who cannot re-apply gets the advisory, not the banner", async ({ as }) => {
  test.setTimeout(120_000);
  const admin = await as("super");
  const person = await makeThrowawayPerson(admin, "Components");
  const subject = await userPath(admin, person.email);
  const name = `E2E advisory component ${Date.now()}`;

  try {
    const grant = await admin.request.post("/v1/access-rules", {
      headers: SPA_HEADERS,
      data: { subject_kind: "user", subject, collection: "pay-components", scope: "all", level: "write", effect: "allow" },
    });
    expect(grant.status(), await grant.text()).toBe(200);

    const page = await as({ email: person.email });
    await gotoRoute(page, "settings/pay-components");
    // `.first()`: the toolbar button. An EMPTY table offers the very same action again in its placeholder
    // (DataTable takes one `createBtn` for both `toolbar` and `emptyAction`), and this catalog starts empty.
    await page.getByRole("button", { name: "New component" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name").fill(name);
    await form.getByRole("button", { name: "Create", exact: true }).click();

    await expect(toast(page, "Pay component created")).toBeVisible({ timeout: 30_000 });
    // The advisory, not a "re-apply to all employees" button this caller holds no grant to press.
    await expect(toast(page, "Employee splits may be out of date")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Re-apply to all employees" })).toHaveCount(0);
  } finally {
    await purgeComponent(admin, name);
    for (const rule of await accessRules(admin)) {
      if (rule.subject === subject) await admin.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
    await retireThrowawayPerson(admin, person.path);
  }
});

async function purgeComponent(page: import("@playwright/test").Page, name: string): Promise<void> {
  const res = await page.request.get("/v1/pay-components?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  const row = results.find((c) => c.display_name === name);
  if (row) await purge(page, row.path);
}
