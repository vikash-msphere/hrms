import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// The dispatch budget (src/services/automationEngine.ts's MAX_TOTAL_DISPATCHES) - a runaway chain of
// rules re-triggering each other is capped per originating action, and once it trips a `dropped`
// automation_runs row is written (automation_id null - no rule caused it, none is to blame) so the org sees
// it in the Workflows UI instead of only in Workers Logs. Never exercised before this: every other workflow
// spec fires at most one or two rules. A single rule that emits its OWN trigger type three times over
// (self-referencing, still gated on this run's own stamped category) branches 3^depth per level and blows
// past the budget well inside the engine's own depth cap of 5 (3+9+27+81+243 = 363 emissions) - entirely inside
// the one POST that raises the ticket, and entirely scoped to it: the budget is per-request, so this can't
// touch any other spec's rules or data.
test("a rule that re-triggers itself trips the dispatch budget and records a dropped run", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E dispatch budget ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow dispatch budget ${stamp}`);

  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(ruleName);

  await form.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Ticket created", exact: true }).click();

  const onlyIf = form.locator("section").filter({ hasText: "Only if" });
  await onlyIf.getByRole("button", { name: "Add condition" }).click();
  await onlyIf.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "category", exact: true }).click();
  await onlyIf.getByPlaceholder("value").fill(category);

  // Three emits of the rule's own trigger type - each one re-enters the engine and, since the condition still
  // matches (the re-emitted event inherits the same category), fires this same rule again.
  const thenDo = form.locator("section").filter({ hasText: "Then do this" });
  for (let i = 0; i < 3; i++) {
    await thenDo.getByRole("button", { name: "Add step" }).click();
    await page.getByRole("menuitem", { name: "Emit an event" }).click();
    await thenDo.getByRole("combobox").last().click();
    await page.getByRole("option", { name: "Ticket created (ticket.created)", exact: true }).click();
  }

  await expect(form.getByText(/^When /).first()).toBeVisible({ timeout: 30_000 });
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/v1/automations") && r.request().method() === "POST", { timeout: 30_000 }),
    form.getByRole("button", { name: "Create rule" }).click(),
  ]);
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(ruleName).first()).toBeVisible({ timeout: 30_000 });

  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject: `E2E workflow dispatch-budget trigger ${stamp}`, category, description: "Raised by the e2e suite to run the rule engine's own chain out of budget." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  let dropped: Run | undefined;
  await expect
    .poll(async () => {
      dropped = (await runsForSubject(page, ticket.path)).find((r) => r.status === "dropped");
      return !!dropped;
    }, { timeout: 60_000 })
    .toBe(true);
  expect(dropped!.automation, "a dropped run should name no rule - none caused it, none is to blame").toBeUndefined();
  // The NUMBER is not pinned here - it is sized against the largest bounded bulk act and test/dispatchBudget.test.ts
  // holds that relationship. What this asserts is that the budget is what refused the chain.
  expect(dropped!.result?.[0]?.detail).toMatch(/Dispatch budget of \d+ exhausted/);

  // And the Workflows UI itself, which is the whole point of writing the row: an admin looking at Runs sees
  // it, not just Workers Logs.
  await page.getByRole("button", { name: "Runs" }).click();
  await expect(async () => {
    const refresh = page.getByRole("button", { name: "Refresh" });
    if (await refresh.count()) await refresh.first().click();
    await expect(page.getByText("Dispatch budget exhausted").first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });

  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;
type Run = { path: string; subject?: string; status: string; automation?: string; result?: { kind: string; status: string; detail?: string }[] };

/** Every automation-run naming this subject, followed to the end of the (possibly many-page) list. */
async function runsForSubject(page: Page, subject: string): Promise<Run[]> {
  const found: Run[] = [];
  let token: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await page.request.get(`/v1/automation-runs?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
    if (!res.ok()) break;
    const body = (await res.json()) as { results?: Run[]; next_page_token?: string };
    found.push(...(body.results ?? []).filter((r) => r.subject === subject));
    token = body.next_page_token;
    if (!token) break;
  }
  return found;
}

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E dispatch budget "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-budget-";
