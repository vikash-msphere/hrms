import { gotoRoute, patchSettings, test, expect } from "./fixtures";

// The AI switches in the ON direction, which `aiFallback.spec.ts` deliberately does not cover.
//
// WHY THIS IS WORTH A SPEC. Every AI control is hidden behind `useAiFeature` (web/src/lib/aiFeatures.ts).
// `aiFallback` proves they are absent when the feature is off - which would pass just as happily if they
// were absent ALWAYS, i.e. if the switch had shipped dead. Only turning one on proves otherwise. These are
// the positive controls for those absence assertions.
//
// THIS LANE HAS A LIVE AI BINDING, which is the thing to know before extending this file. `wrangler dev`
// honours `[ai]` from wrangler.toml and proxies it to the real service - its own log says "AI bindings always
// access remote resources, and so may incur usage charges even in local dev". So a spec that enables a
// feature AND triggers it spends the account's neuron allowance on every run, which is the same egress
// mistake the suite has already made twice with email and Sentry.
//
// The rule that follows: a spec may turn a feature ON to check the affordance RENDERS, and must not then
// make the app call the model. Asserting the control is there is free; pressing it is not. Everything about
// what the model actually returns belongs in the unit suite against a fake (test/aiDraft.test.ts,
// test/tableAssist.test.ts), where it costs nothing and is deterministic.
//
// Each test restores the setting in a `finally`, because the switches are ORG-WIDE: left on, they would leak
// into every other spec sharing this lane and turn unrelated absence assertions into flakes.
test.describe("an AI feature switched on", () => {
  test("puts the Draft button on the announcement composer", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("hr");

    await patchSettings(page, "ai", (v) => ({ ...v, features: { ...(v.features as object), drafting: true } }));
    try {
      await gotoRoute(page, "announcements", "Feed");
      await page.getByRole("button", { name: "Choose what to post" }).click();
      await page.getByRole("menuitem", { name: "Announcement" }).click();
      const composer = page.getByRole("dialog");

      // The positive control. Not clicked: opening the dialog is free, and pressing Draft would reach the
      // live binding. What the model returns is covered against a fake in test/aiDraft.test.ts.
      await expect(composer.getByRole("button", { name: /^Draft$/ })).toBeVisible({ timeout: 30_000 });
    } finally {
      await patchSettings(page, "ai", (v) => ({ ...v, features: { ...(v.features as object), drafting: false } }));
    }
  });

  test("puts the description field on the table builder, and leaving it blank still creates the table", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("super");
    const name = `E2E ai-on table ${Date.now()}`;

    await patchSettings(page, "ai", (v) => ({ ...v, features: { ...(v.features as object), "tables.describe": true } }));
    try {
      await gotoRoute(page, "tables");
      await page.getByRole("button", { name: /New table|Build a table/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      // Present now, absent in `aiFallback`: the same positive-control argument.
      await expect(dialog.getByLabel("What should it show?")).toBeVisible({ timeout: 30_000 });

      // Left BLANK on purpose. Filling it would make the create call the model. Blank exercises the branch
      // that matters anyway - the field being offered must not change what happens when nobody uses it.
      await dialog.getByLabel("Name").fill(name);
      await dialog.getByRole("button", { name: /Create|Save/ }).first().click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole("main")).toContainText(name, { timeout: 30_000 });
    } finally {
      await patchSettings(page, "ai", (v) => ({ ...v, features: { ...(v.features as object), "tables.describe": false } }));
    }
  });
});
