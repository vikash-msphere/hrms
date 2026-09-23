import { SPA_HEADERS, gotoRoute, toast, test, expect } from "./fixtures";

// The templates behind a checklist, not the checklist itself.
//
// `onboarding.spec.ts` starts a process FROM a template and `transitionTasks.spec.ts` works the checklist
// that produces - both against whatever the org already has configured. Neither ever opens the editor that
// WRITES a template: an ordered task list, each task's assignee resolved by relationship rather than a fixed
// person (the employee themselves, their manager, or someone specific), a due date as an offset from the
// anchor, and - onboarding only - the background-check type and the document a task should collect. All of
// that is `settings/transition-templates`, edited here and nowhere else.
test("a template is built with a relationship-assigned task, saved, and reads back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E template ${Date.now()}`;
  const taskTitle = `E2E task ${Date.now()}`;

  const before = await page.request.get("/v1/settings/transition-templates");
  const kept = before.ok() ? ((await before.json()) as { value?: unknown }).value : undefined;

  await gotoRoute(page, "settings/onboarding-templates", "Onboarding & offboarding");
  // "Add template"/"Add task" both append, so the one this spec just added is always the LAST of its kind -
  // true again after the reload below, since saving preserves array order rather than reshuffling it.
  await page.getByRole("button", { name: "Add template" }).click();
  const tpl = page.locator("div.rounded-lg.border").last();
  await tpl.getByPlaceholder("Template name").fill(name);

  const task = tpl.locator("div.grid").last();
  await task.getByPlaceholder("Task title").fill(taskTitle);
  await task.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Their manager" }).click();
  await task.locator('input[type="number"]').fill("5");
  // Onboarding-only fields, in the order they render: assignee first, then background-check, then the
  // document to collect - both default to the same "None" text, so position rather than a name is what
  // picks background-check out from its neighbour.
  await task.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "Identity", exact: true }).click();

  try {
    await page.getByRole("button", { name: "Save templates" }).click();
    await expect(toast(page, "Templates saved")).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.locator("h1").first()).toHaveText("Onboarding & offboarding", { timeout: 30_000 });
    const reopenedTpl = page.locator("div.rounded-lg.border").last();
    await expect(reopenedTpl.getByPlaceholder("Template name")).toHaveValue(name, { timeout: 30_000 });
    const reopenedTask = reopenedTpl.locator("div.grid").last();
    await expect(reopenedTask.getByPlaceholder("Task title")).toHaveValue(taskTitle);
    await expect(reopenedTask.getByRole("combobox").first()).toHaveText("Their manager");
    await expect(reopenedTask.locator('input[type="number"]')).toHaveValue("5");
    await expect(reopenedTask.getByRole("combobox").nth(1)).toHaveText("Identity");
  } finally {
    // Org-wide config, shared with every other spec's onboarding/offboarding flow - restored exactly, over
    // the wire rather than through the panel a second time (the panel's own save already proved the write).
    await page.request.patch("/v1/settings/transition-templates", { headers: SPA_HEADERS, data: { value: kept ?? {} } }).catch(() => undefined);
  }
});
