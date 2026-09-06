import { gotoRoute, test, expect } from "./fixtures";

// The automation builder, composing a rule.
//
// A workflow rule is trigger → condition → actions, chosen from a list of sixty events - which is a blank
// page unless something fills it in. That is what the recipes are for, and both they and the preview only
// exist in the rendered dialog: an untouched builder offers recipes, pressing one fills the trigger and the
// actions, and the preview then reads the rule back as a sentence ("When … → do …") before anybody saves.
// `test/automations.test.ts` and `test/workflowsE2E.test.ts` own what a saved rule DOES; this is about
// whether a person can build one at all.
test("the builder starts blank, a recipe fills it, and the preview reads it back", async ({ as }) => {
  const page = await as("super");

  await gotoRoute(page, "workflows", "Workflows");
  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByRole("dialog");

  // Blank: the preview says what is missing rather than showing an empty frame, and the save is refused
  // with a reason.
  await expect(form.getByText("Pick a trigger to start…")).toBeVisible();
  await expect(form.getByRole("button", { name: "Create rule" })).toBeDisabled();

  // The recipes, offered only while the form is untouched - which is exactly when they are useful, and is
  // also what stops one overwriting something already typed.
  await expect(form.getByText("Start from")).toBeVisible();
  const recipes = form.locator("button.rounded-full");
  await expect(recipes.first()).toBeVisible();
  const recipeName = ((await recipes.first().innerText()) || "").trim();
  await recipes.first().click();

  // Filled: the trigger is chosen, the preview reads the rule back, and the recipes are gone (the form is no
  // longer untouched).
  await expect(form.getByText("Pick a trigger to start…")).toHaveCount(0);
  await expect(form.getByText("Preview")).toBeVisible();
  await expect(form.getByText(/^When /).first()).toBeVisible();
  await expect(form.getByText("Start from")).toHaveCount(0);
  expect(recipeName.length).toBeGreaterThan(0);

  // Nothing is saved: this spec is about composing, and a live rule fires at everybody in the org.
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog");
  if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
    await discard.getByRole("button", { name: /Discard|Leave/ }).click();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
