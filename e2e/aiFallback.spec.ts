import { gotoRoute, test, expect } from "./fixtures";

// The app with the AI layer switched off, which is how it ships and how this stack runs.
//
// THE CLAIM THIS PINS: "every feature degrades to its non-AI self". It is stated in ai-plan.md, asserted all
// over the unit tests with fake models, and until now never checked in a browser against a stack that has no
// `AI` binding at all - which is the configuration every deployment starts in and most will stay in.
//
// The unit suite cannot check this half. It proves that `semanticHits` returns [] with no binding and that
// `draftText` throws when the feature is off; it cannot prove that the search box still finds things, or that
// nothing renders a button whose only outcome is to explain that it does not work. That second one is the
// failure this file was written after finding: the Draft affordance rendered unconditionally, so a person on
// a default deployment got a button that answered "AI drafting is switched off for this organisation".
//
// Everything here asserts ABSENCE plus CONTINUITY: the AI affordance is gone, and the thing it sits next to
// still works exactly as it did before any of this existed.
test.describe("with no AI configured", () => {
  test("global search still finds records through the keyword index", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await expect(search).toBeVisible();

    // The semantic half is skipped entirely with no binding, so this is the FTS path answering on its own.
    // If the hybrid retrieval had broken the query or thrown, this is where it would show.
    await search.fill("Eve Employee");
    await expect(page.getByRole("button").filter({ hasText: "Eve Employee" }).first()).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();
  });

  test("the announcement composer offers no Draft button, and still posts", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("hr");
    const title = `E2E no-ai post ${Date.now()}`;

    await gotoRoute(page, "announcements", "Feed");
    await page.getByRole("button", { name: "Choose what to post" }).click();
    await page.getByRole("menuitem", { name: "Announcement" }).click();
    const composer = page.getByRole("dialog");

    // The affordance is absent, not disabled. A disabled control still says "there is a thing here you
    // cannot have", which for a feature the org never enabled is a promise about a product they do not run.
    await expect(composer.getByRole("button", { name: /Draft|Improve/ })).toHaveCount(0);

    // And the composer is otherwise untouched: the body field it sits above still takes text and still posts.
    await composer.getByPlaceholder("Say it in a line").fill(title);
    await composer.getByPlaceholder("What's on your mind?").fill("Posted with no model anywhere near it.");
    await composer.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("div.shadow-card").filter({ hasText: title }).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the team report's period comparison shows its figures and credits no model", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("manager");
    await gotoRoute(page, "team-analytics", "Team analytics");

    // The one panel in the app that is SUPPOSED to render with no model behind it. `narrateAnalytics` finds
    // the movements arithmetically and only then asks for prose, so with no binding it still answers - the
    // same findings, with a deterministic summary the panel does not print. Asserting its absence alongside
    // the Draft button's would be wrong: what belongs here is that the panel works and says nothing about AI.
    await page.getByRole("button", { name: "What changed since the previous period" }).click();

    const panel = page.locator("div").filter({ hasText: /^What changed/ }).last();
    // The compared-with line renders only once the response is in, so it is the "it resolved" signal - and it
    // resolved through a path that never touched a model.
    await expect(panel.getByText(/against \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/)).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText("Comparing with the previous period...")).toHaveCount(0);

    // No badge, because nothing wrote anything. The badge is the whole of this feature's AI surface, so its
    // absence is the hide-never-disable check for this panel.
    await expect(page.getByText("Written by AI from the figures below.")).toHaveCount(0);
  });

  test("the table builder offers no description field, and still creates a table", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("super");
    const name = `E2E no-ai table ${Date.now()}`;

    await gotoRoute(page, "tables");
    await page.getByRole("button", { name: /New table|Build a table/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The natural-language field is not offered. An input that cannot do anything is worse than no input:
    // somebody types a sentence into it and watches it be ignored.
    await expect(dialog.getByLabel("What should it show?")).toHaveCount(0);

    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: /Create|Save/ }).first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    // The table was made, empty, exactly as it was before the describe path existed.
    await expect(page.getByRole("main")).toContainText(name, { timeout: 30_000 });
  });
});
