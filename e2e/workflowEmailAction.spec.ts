import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// The "Send an email" action - `workflowFires.spec.ts` proves the builder writes a rule the engine reads,
// but only ever with "Notify someone". Seven other action kinds (notifyManager, notifyAudience, email,
// emailAudience, apiCall, waitFor, wait, emitEvent, webhook) have never been composed or saved through the
// dialog. Email is the one most likely to actually be reached for (a real notification outside the app,
// not just an in-app one), so it's this spec's own subject - fenced the same way workflowFires is, on a
// ticket category only this run's ticket carries.
test("a rule with an email action fires on a real event and records its run", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E email action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow email ${stamp}`);

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

  // The action: emails the subject of the event (whoever raised the ticket) - this run's own person, same
  // reasoning workflowFires uses for "Notify someone".
  const thenDo = form.locator("section").filter({ hasText: "Then do this" });
  await thenDo.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Send an email" }).click();
  await thenDo.getByPlaceholder("Email subject").fill(`Fired for ${category}`);
  await thenDo.getByPlaceholder("<p>…</p>").fill(`<p>Fired by ${category}</p>`);

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
    data: { subject: `E2E workflow email trigger ${stamp}`, category, description: "Raised by the e2e suite to set an email rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

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

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E email action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-email-";
