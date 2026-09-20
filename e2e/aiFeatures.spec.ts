import { aiLocalUp, gotoRoute, patchSettings, purge, runCron, SPA_HEADERS, test, expect } from "./fixtures";

// The AI layer in a browser, in its three states: switched off, switched on, and switched on with a model
// answering.
//
// WHY ONE FILE AND NOT THREE. These were three files - `aiFallback`, `aiFeatureSwitch`, `aiLocalModel` - and
// that arrangement was broken by construction. The feature switches live in ONE org-wide settings blob, and
// `playwright.config.ts` runs different FILES in parallel (`fullyParallel: false` only serialises within a
// file). So the spec asserting the Draft button is absent and the spec asserting it is present were reading
// and writing the same row from two workers at once: a real race that surfaced as
//
//     Expected: 0   Received: 1   getByRole('dialog').getByLabel('What should it show?')
//
// and then passed on retry, which is the worst way for it to behave. Retries hid it. Two statements about the
// same switch cannot live in two files while the switch is org-wide, so they live here, in one file, in one
// worker, in order.
//
// THE THREE DESCRIBES ARE ONE ARGUMENT, and each is worthless without the next:
//
//   1. OFF: the affordance is absent and the thing it sits next to still works. On its own this would pass
//      just as happily if every AI control had shipped dead.
//   2. ON: the affordance appears. The positive control for (1) - and no more than that, because it must keep
//      passing on a machine with no local model, so it may not press anything.
//   3. ON, WITH A MODEL: the affordance does something. Skipped when Ollama is down.
//
// ON EGRESS, which is why (2) and (3) are separate at all. `wrangler dev` proxies the `[ai]` binding to the
// real service - its own log warns "AI bindings always access remote resources, and so may incur usage
// charges even in local dev" - so this lane could once spend the account's daily neuron allowance on every
// run, and did: an earlier version of (2) pressed the buttons. `AI_LOCAL_URL` in e2e/e2e.vars now points the
// whole layer at a model on this machine and src/deps.ts prefers it over the binding, so (3) costs nothing.
// (2) still may not press anything, because its job is to pass with nothing local running.
//
// Every test restores its setting in a `finally`. Within this file that is ordering hygiene; across the ~350
// other specs sharing this lane it is what stops a left-on switch turning somebody else's assertion into a
// flake.

const off = (key: string) => (v: Record<string, unknown>) => ({ ...v, features: { ...(v.features as object), [key]: false } });
const on = (key: string) => (v: Record<string, unknown>) => ({ ...v, features: { ...(v.features as object), [key]: true } });

// ---------------------------------------------------------------------------------------------------------
// 1. Switched off, which is how the app ships.
//
// THE CLAIM THIS PINS: "every feature degrades to its non-AI self". It is stated in ai-plan.md, asserted all
// over the unit tests with fake models, and until this file existed never checked in a browser.
//
// WHAT MAKES IT TRUE HERE IS THE SETTINGS, NOT A MISSING BINDING. `wrangler dev` honours `[ai]`, so the lane
// has a live binding; and `AI_LOCAL_URL` gives it a second model it could reach. Every feature is off by
// default, which is why nothing below reaches either.
//
// The unit suite cannot check this half. It proves that `semanticHits` returns [] with no binding and that
// `draftText` throws when the feature is off; it cannot prove that the search box still finds things, or that
// nothing renders a button whose only outcome is to explain that it does not work. That second one is the
// failure this was written after finding: the Draft affordance rendered unconditionally, so a person on a
// default deployment got a button that answered "AI drafting is switched off for this organisation".
//
// Everything here asserts ABSENCE plus CONTINUITY: the AI affordance is gone, and the thing it sits next to
// still works exactly as it did before any of this existed.
test.describe("with the AI features switched off", () => {
  test("global search still finds records through the keyword index", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await expect(search).toBeVisible();

    // The semantic half is skipped entirely with the feature off, so this is the FTS path answering on its
    // own. If the hybrid retrieval had broken the query or thrown, this is where it would show.
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
    // the movements arithmetically and only then asks for prose, so with the feature off it still answers -
    // the same findings, with a deterministic summary the panel does not print. Asserting its absence
    // alongside the Draft button's would be wrong: what belongs here is that the panel works and says
    // nothing about AI.
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

// ---------------------------------------------------------------------------------------------------------
// 2. Switched on: the affordance appears.
//
// Every AI control is hidden behind `useAiFeature` (web/src/lib/aiFeatures.ts), and the describe above would
// pass just as happily if those controls were absent ALWAYS - if the switch had shipped dead. These are the
// positive controls that rule that out, and nothing more: they may not press anything, because they have to
// keep passing on a machine with no local model. What the model returns is covered against a fake in the unit
// suite (test/aiDraft.test.ts, test/tableAssist.test.ts) and against a real one in describe 3.
test.describe("an AI feature switched on", () => {
  test("puts the Draft button on the announcement composer", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("hr");

    await patchSettings(page, "ai", on("drafting"));
    try {
      await gotoRoute(page, "announcements", "Feed");
      await page.getByRole("button", { name: "Choose what to post" }).click();
      await page.getByRole("menuitem", { name: "Announcement" }).click();
      const composer = page.getByRole("dialog");

      await expect(composer.getByRole("button", { name: /^Draft$/ })).toBeVisible({ timeout: 30_000 });
    } finally {
      await patchSettings(page, "ai", off("drafting"));
    }
  });

  test("puts the description field on the table builder, and leaving it blank still creates the table", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("super");
    const name = `E2E ai-on table ${Date.now()}`;

    await patchSettings(page, "ai", on("tables.describe"));
    try {
      await gotoRoute(page, "tables");
      await page.getByRole("button", { name: /New table|Build a table/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      await expect(dialog.getByLabel("What should it show?")).toBeVisible({ timeout: 30_000 });

      // Left BLANK on purpose. Filling it would make the create call the model, which this describe may not
      // do. Blank exercises the branch that matters anyway - the field being offered must not change what
      // happens when nobody uses it.
      await dialog.getByLabel("Name").fill(name);
      await dialog.getByRole("button", { name: /Create|Save/ }).first().click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole("main")).toContainText(name, { timeout: 30_000 });
    } finally {
      await patchSettings(page, "ai", off("tables.describe"));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. Switched on with a model answering: the affordance does something.
//
// SKIPPED WHEN OLLAMA IS DOWN, because it is an optional dependency of this repository rather than part of
// the stack `scripts/e2eStack.sh` starts. So a green run does not mean these ran - read the skip count.
// docs/04-testing.md has the setup and the full account of what a local pass proves.
//
// WHAT A PASS IS EVIDENCE OF: the round trip - affordance, request, service, model, parser, result on screen.
// It is NOT evidence about the production models. A local Gemma is not
// `@cf/meta/llama-3.1-8b-instruct-fast`, and how well either writes is not a thing a browser test can assert.
test.describe("an AI feature with a model behind it", () => {
  test("Draft writes text into the announcement composer", async ({ as }) => {
    test.setTimeout(240_000); // a cold local model is slow in a way the hosted one is not
    const page = await as("hr");
    test.skip(!(await aiLocalUp(page)), "no local model on this machine (see docs/04-testing.md)");

    await patchSettings(page, "ai", on("drafting"));
    try {
      await gotoRoute(page, "announcements", "Feed");
      await page.getByRole("button", { name: "Choose what to post" }).click();
      await page.getByRole("menuitem", { name: "Announcement" }).click();
      const composer = page.getByRole("dialog");

      const body = composer.getByPlaceholder("What's on your mind?");
      await expect(body).toHaveValue("");

      await composer.getByRole("button", { name: /^Draft$/ }).click();
      // The draft dialog opens ON TOP of the composer, so both are `role=dialog` and the footer button shares
      // its name with the trigger. Filtering by the title is what keeps this from clicking the composer's own
      // Draft button again and waiting forever for text that never arrives.
      const ask = page.getByRole("dialog").filter({ hasText: "Draft this text" });
      await ask.getByRole("textbox").fill("the office moves to the second floor from Monday, entry is by the side door");
      await ask.getByRole("button", { name: "Draft", exact: true }).click();

      // THE ASSERTION IS THAT TEXT ARRIVED WHERE THE AUTHOR IS TYPING, not what the text says. A model's
      // wording is not a property this suite can hold, but "the button returns a draft into the field, and
      // the author can still edit it" is exactly the contract DraftButton describes - it saves nothing.
      await expect(ask).toHaveCount(0, { timeout: 180_000 });
      await expect(body).not.toHaveValue("", { timeout: 5_000 });

      // And nothing was posted. The whole design of the drafting feature is that a model writes into a form
      // and a person decides; a draft that published itself would be the one unacceptable outcome.
      await expect(composer).toBeVisible();
    } finally {
      await patchSettings(page, "ai", off("drafting"));
    }
  });

  test("the team report's period comparison is written up, and says so", async ({ as }) => {
    test.setTimeout(240_000);
    const page = await as("manager");
    test.skip(!(await aiLocalUp(page)), "no local model on this machine (see docs/04-testing.md)");

    // TWO BROWSERS, because the feature switch and the feature are different people's. `settings.write` is a
    // super/HR verb - a manager asking for it gets a flat 403 - while the team report is a manager's page.
    // Flipping the switch from the manager's own session failed on exactly that, which is the seeded policy
    // being right rather than the test being unlucky.
    const admin = await as("super");
    await patchSettings(admin, "ai", on("analytics.narrate"));
    try {
      await gotoRoute(page, "team-analytics", "Team analytics");
      await page.getByRole("button", { name: "What changed since the previous period" }).click();

      const panel = page.locator("div").filter({ hasText: /^What changed/ }).last();
      await expect(panel.getByText(/against \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/)).toBeVisible({ timeout: 180_000 });

      // The badge is the whole of this feature's AI surface and the exact thing describe 1 asserts is ABSENT.
      // Present here, it is that assertion's positive control: without this, an attribution line that had
      // stopped rendering would look like a passing suite.
      //
      // The panel answers either way - the movements are found arithmetically before any prose is asked for -
      // so this is also the check that the model half ran at all rather than falling back.
      await expect(page.getByText("Written by AI from the figures below.")).toBeVisible({ timeout: 180_000 });
    } finally {
      await patchSettings(admin, "ai", off("analytics.narrate"));
    }
  });

  test("reading a CV fills the candidate form from the file", async ({ as }) => {
    test.setTimeout(240_000);
    const page = await as("super");
    test.skip(!(await aiLocalUp(page)), "no local model on this machine (see docs/04-testing.md)");

    const stamp = Date.now();
    const name = `E2E CV ${stamp}`;
    const created = await page.request.post("/v1/candidates", {
      headers: SPA_HEADERS,
      data: { name, email: `e2e.cv.${stamp}@example.com` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const path = ((await created.json()) as { path: string }).path;

    await patchSettings(page, "ai", on("ats.extraction"));
    try {
      await gotoRoute(page, "candidates", "Candidates");
      const row = page.locator("tbody tr").filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });

      // A PDF WITH REAL TEXT IN IT, built with the same pdf-lib the app renders payslips with. The minimal
      // PDF the other candidate specs upload has no content stream, and the panel extracts the text in the
      // BROWSER with pdf.js before anything is sent - so a file with no selectable text never reaches the
      // model at all, it toasts "this may be a scan". A fixture that cannot be read would make this test
      // pass or fail for a reason that has nothing to do with the feature.
      const chooser = page.waitForEvent("filechooser");
      await row.getByRole("button", { name: "Attach" }).click();
      await (await chooser).setFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: await cvPdf() });
      await expect(row.getByRole("button", { name: "View" })).toBeVisible({ timeout: 30_000 });

      await gotoRoute(page, `candidates/${path.split("/").pop()}`);
      await expect(page.getByRole("heading", { name: "Read the CV" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: /^Read CV$/ }).click();

      // WHAT IS ASSERTED IS THAT SOMETHING READ THE FILE, not that the model got every field right. The
      // panel offers each extracted field for a person to Accept one at a time - it saves nothing on its own,
      // which is the whole reason a model is allowed near a candidate record - so a row appearing with an
      // Accept beside it is the round trip completing.
      await expect(page.getByRole("button", { name: "Accept" }).first()).toBeVisible({ timeout: 180_000 });
    } finally {
      await patchSettings(page, "ai", off("ats.extraction"));
      await purge(page, path);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// 4. The half that only the cron tick can reach.
//
// Semantic search, ticket triage and suggestion clustering all read the SAME vector index, and nothing fills
// it on a request - the embed drain does, on the five-minute tick, because `search_docs` is maintained by SQL
// triggers and nothing can tell the app a row changed. So none of these could be covered in a browser at all
// until `runCron` existed; `scripts/e2eStack.sh` passes `--test-scheduled` for it.
//
// NOT COVERED HERE, DELIBERATELY: a flagged post rendering on the moderation queue. Producing one means
// getting a model to judge content unacceptable, and the local model is not Llama Guard - the rule this file
// works under is that a local pass says nothing about how the production classifier judges. A spec that
// posted deliberately objectionable text and asserted on a stand-in's verdict would be claiming exactly what
// describe 3 refuses to claim. `e2e/moderationQueue.spec.ts` covers what a browser CAN settle about that
// feature: it is private by default, and the nav item and the endpoint agree about who may see it.
test.describe("the AI features fed by the cron tick", () => {
  test("semantic search finds a ticket by what it means, not by its words", async ({ as }) => {
    test.setTimeout(300_000);
    const page = await as("super");
    test.skip(!(await aiLocalUp(page)), "no local model on this machine (see docs/04-testing.md)");

    const stamp = Date.now();
    const title = `Laptop overheating ${stamp}`;
    const created = await page.request.post("/v1/tickets", {
      headers: SPA_HEADERS,
      data: { category: "it", subject: title, description: "The fan runs constantly and the case is hot to touch." },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const path = ((await created.json()) as { path: string }).path;

    await patchSettings(page, "ai", on("search.semantic"));
    try {
      // The row is brand new, so it is NEVER-SCANNED - which is the front of the drain's rotation, not the
      // back. That is what makes one tick enough here rather than however many it takes to sweep the seed.
      await runCron(page);

      await gotoRoute(page, "dashboard");
      await page.keyboard.press("ControlOrMeta+k");
      const search = page.getByPlaceholder("Search people, records, pages and settings…");
      await expect(search).toBeVisible();

      // NOT ONE WORD IN COMMON with the ticket, which is the entire point. "computer" is not "laptop", "hot"
      // is not "overheating", and FTS5 matches tokens - so the keyword half of the hybrid cannot answer this
      // query at all. A hit here came through the vector index or it did not come.
      await search.fill("my computer gets too hot");
      await expect(page.getByRole("button").filter({ hasText: title }).first()).toBeVisible({ timeout: 120_000 });
    } finally {
      await patchSettings(page, "ai", off("search.semantic"));
      await purge(page, path);
    }
  });

  test("the same search finds nothing once the feature is switched off", async ({ as }) => {
    test.setTimeout(300_000);
    const page = await as("super");
    test.skip(!(await aiLocalUp(page)), "no local model on this machine (see docs/04-testing.md)");

    const stamp = Date.now();
    const title = `Laptop overheating ${stamp}`;
    const created = await page.request.post("/v1/tickets", {
      headers: SPA_HEADERS,
      data: { category: "it", subject: title, description: "The fan runs constantly and the case is hot to touch." },
    });
    // CHECKED, and this test is the reason to insist on it. Without this line the create failed on a missing
    // `category`, `path` was undefined, and the assertion below - that no row with this title appears -
    // passed because no such row was ever made. A vacuity check that is itself vacuous is the worst of both:
    // it reports that the feature switch is obeyed while testing nothing at all.
    expect(created.ok(), await created.text()).toBe(true);
    const path = ((await created.json()) as { path: string }).path;

    try {
      // THE VACUITY CHECK for the test above, and it is not optional. That one asserts a record is FOUND, and
      // a search box that matched everything would pass it just as well. Same record, same wordless query,
      // feature off: the vector index is never consulted, the FTS half has no token to match, and the right
      // answer is nothing. Embedded first, so this is the feature switch being obeyed rather than an empty
      // index answering by accident.
      await patchSettings(page, "ai", on("search.semantic"));
      await runCron(page);
      await patchSettings(page, "ai", off("search.semantic"));

      await gotoRoute(page, "dashboard");
      await page.keyboard.press("ControlOrMeta+k");
      const search = page.getByPlaceholder("Search people, records, pages and settings…");
      await expect(search).toBeVisible();
      await search.fill("my computer gets too hot");

      // Given a moment to be wrong in: an immediate `toHaveCount(0)` would pass before the request had even
      // returned, which is the failure mode of every "asserts nothing appeared" test.
      await page.waitForTimeout(3_000);
      await expect(page.getByRole("button").filter({ hasText: title })).toHaveCount(0);
    } finally {
      await patchSettings(page, "ai", off("search.semantic"));
      await purge(page, path);
    }
  });
});

/** A one-page CV with selectable text, built with the app's own PDF library. */
async function cvPdf(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    "Priya Raman",
    "priya.raman@example.com",
    "+91 98765 43210",
    "Senior Software Engineer",
    "8 years building payment systems in Bangalore.",
  ];
  lines.forEach((line, i) => page.drawText(line, { x: 60, y: 760 - i * 24, size: 12, font }));
  return Buffer.from(await doc.save());
}
