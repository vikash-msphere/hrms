import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// A rule's own on/off switch (web/src/pages/Workflows.tsx's EnableToggle) - never exercised before this.
// Turning OFF asks first (a bespoke confirm, not the shared confirmDecision copy - "Turn this rule off?");
// turning back ON does not. A disabled rule also earns its own amber notice inside the edit dialog ("This
// rule is turned off..."), which nothing in the suite had reached either.
test("a rule's enable/disable toggle asks before turning off and warns while it is off", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E toggle rule ${stamp}`;

  const made = await page.request.post("/v1/automations", {
    headers: SPA_HEADERS,
    data: {
      name: ruleName,
      trigger_type: "employee.created",
      actions: [{ kind: "notify", recipient: { of: "subject" }, title: "hello" }],
    },
  });
  expect(made.status(), await made.text()).toBe(200);
  const rule = (await made.json()) as { path: string; enabled?: boolean };
  expect(rule.enabled).toBe(true); // a freshly created rule starts on

  try {
    await gotoRoute(page, "workflows", "Workflows");
    // The card is the innermost div that BOTH names this rule and carries its on/off switch. On `hasText`
    // alone, `.last()` resolves to whichever nested div is deepest - a leaf holding only the name, once the
    // list is long enough that other specs' rules are in it - and every assertion below then waits out its
    // timeout on a switch that was never inside what was picked.
    const card = page.locator("div").filter({ hasText: ruleName }).filter({ has: page.getByRole("switch") }).last();
    const toggle = card.getByRole("switch", { name: "Disable rule" });
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();

    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Turn this rule off?")).toBeVisible({ timeout: 15_000 });
    await expect(confirm.getByText(ruleName, { exact: false })).toBeVisible();
    await confirm.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    const off = card.getByRole("switch", { name: "Enable rule" });
    await expect(off).toBeVisible({ timeout: 15_000 });
    await expect(off).toHaveAttribute("aria-checked", "false");

    // The edit dialog's own warning, visible only while the rule is off.
    await card.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editor = page.getByRole("dialog");
    await expect(editor.getByText("This rule is turned off, so nothing here fires until it is switched back on from its card.")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    // Turning back on needs no confirmation.
    await off.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    const backOn = card.getByRole("switch", { name: "Disable rule" });
    await expect(backOn).toBeVisible({ timeout: 15_000 });
    await expect(backOn).toHaveAttribute("aria-checked", "true");
  } finally {
    await purge(page, rule.path);
  }
});
