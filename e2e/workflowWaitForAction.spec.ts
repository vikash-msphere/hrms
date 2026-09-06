import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Wait for an event" - the one action kind that suspends a rule into a durable `workflow_instances` row
// (src/services/automationEngine.ts's suspend/resumeWaiting) instead of finishing inline, and never composed
// through the builder before this. Fenced the same way every other workflow spec is (a stamped ticket
// category), but proven in three real stages instead of one: the instance is actually recorded as "waiting"
// on THIS run's own ticket right after it suspends, a real second event (":resolve", which is what genuinely
// emits `ticket.resolved` - see services/tickets.ts) on that SAME ticket is what resumes it (not a timer, and
// not any other ticket - matched by `subject`), and the instance flips off "waiting" only once its arm's own
// action (a notify) has actually run.
test("a rule with a waitFor action suspends, then resumes and runs its arm on a matching event", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E waitFor action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;
  const title = `E2E waitFor resumed ${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow waitFor ${stamp}`);

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
  await page.getByRole("menuitem", { name: "Wait for an event" }).click();

  // The single event branch the intent defaults to - pick which event it awaits and how it must match, then
  // give the branch its own action (the outer "Add step" is gone now: a waitFor is terminal).
  const arm = form.locator(".border-dashed").first();
  await arm.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "Ticket resolved", exact: true }).click();
  await arm.getByRole("combobox").nth(2).click();
  await page.getByRole("option", { name: "same record", exact: true }).click();

  await form.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("menuitem", { name: "Notify someone" }).click();
  await arm.getByPlaceholder("Notification title").fill(title);

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
    data: { subject: `E2E workflow waitFor trigger ${stamp}`, category, description: "Raised by the e2e suite to set a waitFor rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  type Instance = { subject?: string; status?: string };
  await expect
    .poll(async () => {
      const res = await page.request.get("/v1/workflow-instances?page_size=200");
      if (!res.ok()) return undefined;
      const { results = [] } = (await res.json()) as { results?: Instance[] };
      return results.find((i) => i.subject === ticket.path)?.status;
    }, { timeout: 60_000 })
    .toBe("waiting");

  // A different action would never wake it (matched on "same record") - resolving THIS ticket is the one
  // thing that does.
  const resolved = await page.request.post(`/v1/${ticket.path}:resolve`, { headers: SPA_HEADERS });
  expect(resolved.status(), await resolved.text()).toBe(200);

  await expect
    .poll(async () => {
      const res = await page.request.get("/v1/workflow-instances?page_size=200");
      if (!res.ok()) return undefined;
      const { results = [] } = (await res.json()) as { results?: Instance[] };
      return results.find((i) => i.subject === ticket.path)?.status;
    }, { timeout: 60_000 })
    .not.toBe("waiting");

  let notificationPath: string | undefined;
  await expect
    .poll(async () => {
      const res = await page.request.get("/v1/notifications?page_size=50");
      if (!res.ok()) return false;
      const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
      const found = results.find((n) => n.title === title);
      notificationPath = found?.path;
      return !!found;
    }, { timeout: 60_000 })
    .toBe(true);

  if (notificationPath) await purge(page, notificationPath);
  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E waitFor action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-wait-";
