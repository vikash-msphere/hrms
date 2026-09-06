import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// A rule built in the dialog, and then actually firing.
//
// `workflows.spec.ts` stops at composing one, deliberately: it never saves, because a live rule fires at
// everybody in the org. `test/automations.test.ts` and `test/workflowsE2E.test.ts` own what a rule DOES, but
// they build the rule as an object in a test file. Nobody in either suite ever presses Create and then
// watches the engine react - so the one thing that has never been checked is whether the rule the BUILDER
// writes is the rule the ENGINE reads: a trigger, a condition and an action composed through three different
// editors, serialized, stored, and matched against a real event minutes later. A builder that saved a
// slightly different shape would look perfect in the dialog and quietly do nothing forever, which is the
// worst failure this feature has.
//
// Saving a live rule safely is the whole design of this spec. The trigger is `ticket.created`, which several
// other specs cause, so the rule is fenced by a condition on a CATEGORY that only this spec's ticket carries
// - a free-text field, so the value is unguessably this run's. And the action notifies the subject of the
// event, which is the person who raised that ticket: this spec, about its own row. Nothing it does can reach
// anybody else's queue even if the condition were wrong.
test("a rule composed in the builder fires on a real event and records its run", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E fires ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`; // the fence: no other spec's ticket can carry it

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  // The fence is org CONFIG, not free text: a ticket in a category the org has not configured is refused
  // ("that ticket category is unavailable"), so the run has to open its own desk before it can raise a
  // ticket at it. Taken away again on the way out - a leftover category is a row in everybody's category
  // picker, and the reason it is swept on the way IN as well.
  await addTicketCategory(page, category, `E2E workflow ${stamp}`);

  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(ruleName);

  // 1. The event. Chosen by its human label, grouped by module - which is the only way sixty of them are
  // findable at all.
  await form.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Ticket created", exact: true }).click();

  // 2. The fence. The field list is the trigger's OWN fields (plus the three every event carries), so a
  // condition on `category` is only offerable because the trigger was picked first - which is the part of
  // this dialog that could silently regress into a fixed list.
  const onlyIf = form.locator("section").filter({ hasText: "Only if" });
  await onlyIf.getByRole("button", { name: "Add condition" }).click();
  await onlyIf.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "category", exact: true }).click();
  await onlyIf.getByPlaceholder("value").fill(category);

  // 3. The action. "Notify someone" defaults to the subject of the event - the person the thing happened to.
  const thenDo = form.locator("section").filter({ hasText: "Then do this" });
  await thenDo.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Notify someone" }).click();
  await thenDo.getByPlaceholder("Notification title").fill(`Fired for ${category}`);

  // The preview reads the whole thing back before it is live, which is the last chance to notice the rule
  // says something other than what was meant.
  await expect(form.getByText(/^When /).first()).toBeVisible({ timeout: 30_000 });
  // The save itself is asserted, not just its effect on the dialog: a rejected write leaves a dialog that
  // looks stuck, and the reason for it is in the response body rather than anywhere on the screen.
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/v1/automations") && r.request().method() === "POST", { timeout: 30_000 }),
    form.getByRole("button", { name: "Create rule" }).click(),
  ]);
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(ruleName).first()).toBeVisible({ timeout: 30_000 });

  // Something happens, elsewhere in the app - through the same lane a person's press would take.
  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject: `E2E workflow trigger ${stamp}`, category, description: "Raised by the e2e suite to set a rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  // And the engine ran the rule. Read through the tab's own Refresh - the affordance an admin watching an
  // automation actually uses - and polled, because the run is recorded after the request that caused it has
  // already answered.
  await page.getByRole("button", { name: "Runs" }).click();
  await expect(async () => {
    const refresh = page.getByRole("button", { name: "Refresh" });
    if (await refresh.count()) await refresh.first().click();
    await expect(page.getByText(ruleName).first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });

  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

/**
 * Take out every rule any run of this spec has saved.
 *
 * A leftover rule is not litter, it is a live automation: it keeps matching, keeps writing runs, and keeps
 * notifying somebody every time a ticket happens to carry its category. Swept on the way in as well as out,
 * so a run that died half way cannot leave one firing.
 */
async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E fires "))) await purge(page, r.path);
}

// This spec's own category keys, and NOT any other spec's.
//
// It used to be the bare `e2e-wf-`, which every other workflow spec's prefix begins with (`e2e-wf-email-`,
// `e2e-wf-wait-`, …) - so this spec's sweep deleted their categories out from under them mid-run, and the
// nine of them failed on "that ticket category is unavailable" for a category they had just created. A prefix
// that is a prefix of its neighbours is not a fence.
const CATEGORY_PREFIX = "e2e-wf-fires-";
