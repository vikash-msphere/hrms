import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Wait a while" - a fixed delay, distinct from "Wait for an event": it enqueues its nested `then` actions
// onto the jobs queue with a future `runAfter` (src/services/automationEngine.ts's wait case) and reports
// itself "done" on the SPOT, not "suspended" - the delayed continuation is a separate job the cron drainer
// only picks up once its runAfter has actually passed (`processOneJob`'s `lte(runAfter, now)` filter), which
// a "days" delay can never do inside a test's own lifetime. So what this proves is exactly what happens
// synchronously when the rule fires: the run's own recorded result for this action, read back from
// GET /v1/automation-runs - never composed through the builder before this.
test("a rule with a wait action defers its nested step and records it immediately", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E wait action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;
  const title = `E2E deferred notify ${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow wait ${stamp}`);

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

  const thenDo = form.locator("section").filter({ hasText: "Then do this" });
  await thenDo.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Wait a while" }).click();

  // A plain "wait" (unlike "wait for") isn't terminal, so the outer "Add step" is still on screen - the
  // nested list needs its own container to stay unambiguous.
  const nested = form.locator(".ml-3.border-l.pl-3").first();
  await nested.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Notify someone" }).click();
  await nested.getByPlaceholder("Notification title").fill(title);

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
    data: { subject: `E2E workflow wait trigger ${stamp}`, category, description: "Raised by the e2e suite to set a wait rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  type Action = { kind: string; status: string; detail?: string };
  await expect
    .poll(async () => {
      const res = await page.request.get("/v1/automation-runs?page_size=200");
      if (!res.ok()) return undefined;
      const { results = [] } = (await res.json()) as { results?: { subject?: string; result?: Action[] }[] };
      return results.find((r) => r.subject === ticket.path)?.result?.find((a) => a.kind === "wait");
    }, { timeout: 60_000 })
    .toMatchObject({ kind: "wait", status: "done" });

  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E wait action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-delay-";
