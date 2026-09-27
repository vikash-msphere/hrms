import { SPA_HEADERS, gotoRoute, landedResponse, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Emit an event" - chains a second domain event off the one that fired the rule, carrying the SAME
// subject/employee (src/services/automationEngine.ts's emitEvent case) and, since the builder offers no
// payload editor at all for this action kind (ActionList.tsx's emitEvent case is a bare type picker), the
// ORIGINAL triggering event's own payload. Never composed through the builder before this. Proven via the
// event log itself (GET /v1/event-log?type=), not the Runs tab, since that is the one place the emitted
// event is directly observable - matched on `subject` (this run's own ticket), the one thing guaranteed
// unique here. "announcement.published" is used only because nothing seeded reacts to it, so emitting one
// here has no side effect beyond the log entry.
test("a rule with an emitEvent action writes a second, chained event to the log", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E emitEvent action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow emitEvent ${stamp}`);

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
  await page.getByRole("menuitem", { name: "Emit an event" }).click();
  await thenDo.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Announcement published (announcement.published)", exact: true }).click();

  await expect(form.getByText(/^When /).first()).toBeVisible({ timeout: 30_000 });
  const [saved] = await Promise.all([
    landedResponse(page, (r) => r.url().includes("/v1/automations") && r.request().method() === "POST"),
    form.getByRole("button", { name: "Create rule" }).click(),
  ]);
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(ruleName).first()).toBeVisible({ timeout: 30_000 });

  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject: `E2E workflow emitEvent trigger ${stamp}`, category, description: "Raised by the e2e suite to set an emitEvent rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  await expect
    .poll(async () => {
      const res = await page.request.get("/v1/event-log?type=announcement.published&page_size=50");
      if (!res.ok()) return false;
      const { results = [] } = (await res.json()) as { results?: { subject?: string }[] };
      return results.some((e) => e.subject === ticket.path);
    }, { timeout: 60_000 })
    .toBe(true);

  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E emitEvent action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-emit-";
