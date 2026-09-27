import { SPA_HEADERS, gotoRoute, landedResponse, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Send a webhook" - the one action kind that needs real outbound egress (src/services/automationEngine.ts's
// webhook case: `if (!deps.webhook) return { ..., status: "skipped", detail: "webhook egress not configured" }`)
// and this stack never configures that port, so there is no way to prove a POST actually left the Worker here.
// What IS provable, and never exercised before this: the builder saves the action correctly and the engine
// runs it to a clean, documented "skipped" outcome rather than erroring or silently dropping it - read back
// from the run's own recorded result (GET /v1/automation-runs), not the Runs tab's icon-only rendering.
test("a rule with a webhook action records a clean skip when egress is not configured", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E webhook action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;
  const url = `https://example.com/e2e-webhook-${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow webhook ${stamp}`);

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
  await page.getByRole("menuitem", { name: "Send a webhook" }).click();
  await thenDo.getByPlaceholder("https://…").fill(url);

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
    data: { subject: `E2E workflow webhook trigger ${stamp}`, category, description: "Raised by the e2e suite to set a webhook rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  await expect
    .poll(async () => {
      const res = await page.request.get("/v1/automation-runs?page_size=200");
      if (!res.ok()) return undefined;
      const { results = [] } = (await res.json()) as { results?: { subject?: string; result?: { kind: string; status: string; detail?: string }[] }[] };
      const run = results.find((r) => r.subject === ticket.path);
      return run?.result?.find((a) => a.kind === "webhook");
    }, { timeout: 60_000 })
    .toMatchObject({ kind: "webhook", status: "skipped", detail: "webhook egress not configured" });

  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E webhook action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-hook-";
