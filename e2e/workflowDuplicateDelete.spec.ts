import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Two items on the rule card's "More" menu that `workflowEnableToggle.spec.ts` (Edit) and `workflowDryRun.
// spec.ts` (Test) leave untouched: Duplicate opens the builder pre-filled as a brand NEW rule named
// "<name> (copy)" rather than editing the original in place, and Delete removes a rule outright ("stops
// firing and is removed" - unlike the toggle, which only pauses it). Neither has ever been pressed.
test("a rule is duplicated into a real second rule, and both are deleted", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E dup rule ${stamp}`;
  const copyName = `${ruleName} (copy)`;

  const made = await page.request.post("/v1/automations", {
    headers: SPA_HEADERS,
    data: { name: ruleName, trigger_type: "employee.created", actions: [{ kind: "notify", recipient: { of: "subject" }, title: "hello" }] },
  });
  expect(made.status(), await made.text()).toBe(200);
  const original = (await made.json()) as { path: string };

  try {
    await gotoRoute(page, "workflows", "Workflows");
    const cardOf = (name: string) => page.locator("div").filter({ hasText: name }).filter({ has: page.getByRole("switch") }).last();
    const original_ = cardOf(ruleName);
    await expect(original_).toBeVisible({ timeout: 30_000 });
    await original_.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();

    // A new, unsaved rule - not the original reopened. Pre-filled with its trigger and actions (the preview
    // reads it back), and named for what it is.
    const builder = page.getByRole("dialog");
    await expect(builder.getByLabel("Name")).toHaveValue(copyName, { timeout: 30_000 });
    await expect(builder.getByText(/^When /).first()).toBeVisible();
    const create = builder.getByRole("button", { name: "Create rule" });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // A real, separate row: the original is untouched, and the copy is its own rule beside it.
    await expect(cardOf(ruleName)).toBeVisible({ timeout: 30_000 });
    const copyCard = cardOf(copyName);
    await expect(copyCard).toBeVisible({ timeout: 30_000 });

    // Delete the copy first, so what remains on screen for the original's own delete is unambiguous.
    await copyCard.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirmCopy = page.getByRole("dialog").filter({ hasText: "Delete this rule?" });
    await expect(confirmCopy).toBeVisible({ timeout: 30_000 });
    await expect(confirmCopy.getByText(new RegExp(copyName.replace(/[()]/g, "\\$&")))).toBeVisible();
    await confirmCopy.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(toast(page, "Rule deleted")).toBeVisible({ timeout: 30_000 });
    await expect(cardOf(copyName)).toHaveCount(0, { timeout: 30_000 });

    // And the original, the same way.
    await original_.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirmOrig = page.getByRole("dialog").filter({ hasText: "Delete this rule?" });
    await expect(confirmOrig).toBeVisible({ timeout: 30_000 });
    await confirmOrig.getByRole("button", { name: "Delete", exact: true }).click();
    // Not on the card count alone: `cardOf` needs the card's SWITCH by role, and while the confirm is still
    // closing the modal aria-hides the page, so the count reads 0 at once - before the DELETE has landed, and
    // the cleanup below then purged the rule under it (the UI's DELETE answered 404). The "Rule deleted" toast
    // is no wait either: the copy's delete already raised that text.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(cardOf(ruleName)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await namedRules(page, ruleName)).length, { timeout: 30_000 }).toBe(0);
  } finally {
    // By NAME, not by the path this test has just deleted through the UI: `automations` is a hard delete
    // (src/routes/automations.ts - "a rule that no longer exists must not sit in the trash still firing"),
    // so purging the row the body removed answers 404 for a rule that is correctly gone.
    await purgeNamed(page, ruleName);
    await purgeNamed(page, copyName);
  }
});

async function namedRules(page: import("@playwright/test").Page, name: string): Promise<{ path: string }[]> {
  const res = await page.request.get("/v1/automations?max_page_size=100");
  if (!res.ok()) return [];
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  return results.filter((x) => x.name === name);
}

async function purgeNamed(page: import("@playwright/test").Page, name: string) {
  for (const r of await namedRules(page, name)) await purge(page, r.path);
}
