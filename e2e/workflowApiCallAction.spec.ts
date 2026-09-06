import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Create / update a record" - the most powerful action kind the builder offers (a rule that writes to any
// collection) and, like every action kind besides "Notify someone", never composed or saved through the
// dialog before this. "Act on a record" mode defaults to patching the event's own subject - this spec's own
// ticket - so proving the engine executed the write is as simple as reading back one field it changed,
// fenced the same way `workflowFires.spec.ts` fences its own rule.
test("a rule with an apiCall action patches the triggering record itself", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E apiCall action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow apiCall ${stamp}`);

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
  await page.getByRole("menuitem", { name: "Create / update a record" }).click();
  // "Do", the mode picker, is the first control the new step renders - before it is set, the raw-call
  // fields underneath it (method/path) are also on screen and register their own combobox.
  await thenDo.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Act on a record", exact: true }).click();
  // "Which record" defaults to {{subject}} and the verb to Update, both already right for "patch the ticket
  // this rule fired on" - only the field being changed needs a row of its own.
  await thenDo.getByRole("button", { name: "Add field" }).click();
  await thenDo.getByPlaceholder("field").fill("priority");
  await thenDo.getByPlaceholder("value").fill("high");

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
    data: { subject: `E2E workflow apiCall trigger ${stamp}`, category, description: "Raised by the e2e suite to set an apiCall rule off.", priority: "low" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  // Not the Runs tab this time - the ticket's own priority field is the proof the write actually landed,
  // not just that the engine logged an attempt.
  await expect
    .poll(async () => {
      const got = await page.request.get(`/v1/${ticket.path}`);
      return got.ok() ? ((await got.json()) as { priority?: string }).priority : undefined;
    }, { timeout: 60_000 })
    .toBe("high");

  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E apiCall action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-api-";
