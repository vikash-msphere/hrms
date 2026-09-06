import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Notify the manager" - one field ("What is it about"), and never composed through the builder before this.
// It resolves the MANAGER of the event's own employee (src/services/notifications.ts's notifyManager), which
// for a ticket is whoever raised it - super's own manager is the seeded "manager" fixture, so this reaches a
// second, predictable person rather than the requester itself the way `workflowFires`/`workflowEmailAction`
// do.
test("a rule with a notifyManager action reaches the requester's manager", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E notifyManager action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;
  const noun = `e2e review item ${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow notifyManager ${stamp}`);

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
  await page.getByRole("menuitem", { name: "Notify the manager" }).click();
  await thenDo.getByPlaceholder(/leave request to review/).fill(noun);

  await expect(form.getByText(/^When /).first()).toBeVisible({ timeout: 30_000 });
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/v1/automations") && r.request().method() === "POST", { timeout: 30_000 }),
    form.getByRole("button", { name: "Create rule" }).click(),
  ]);
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(ruleName).first()).toBeVisible({ timeout: 30_000 });

  // Raised as super, whose seeded manager is the "manager" fixture (Mara) - a second, real person the rule
  // has to actually reach, not just the requester it was raised by.
  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject: `E2E workflow notifyManager trigger ${stamp}`, category, description: "Raised by the e2e suite to set a notifyManager rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  const manager = await as("manager");
  const title = `New ${noun} to review`;
  let notificationPath: string | undefined;
  await expect
    .poll(async () => {
      const res = await manager.request.get("/v1/notifications?page_size=50");
      if (!res.ok()) return false;
      const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
      const found = results.find((n) => n.title === title);
      notificationPath = found?.path;
      return !!found;
    }, { timeout: 60_000 })
    .toBe(true);

  if (notificationPath) await purge(manager, notificationPath);
  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E notifyManager action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-mgr-";
