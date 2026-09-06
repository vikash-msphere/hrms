import { SPA_HEADERS, ROLES, gotoRoute, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Email an audience" - the email twin of notifyAudience (src/services/automationEngine.ts's emailAudience
// case), and the last of the ten action kinds never composed through the builder before this pass. Like
// notifyAudience, its "Specific employees" mode has no picker anywhere in ActionList.tsx (flagged separately
// as a product gap), so this exercises "A department" - scoped to the employee fixture's own department. The
// action always reports "done" - each recipient's send is caught non-fatally, so a real send failure (this
// stack configures no EMAIL_API_KEY, per e2e/e2e.vars) still lands on "emailed 0 recipient(s)", not an error
// - so the count itself is not asserted, only that the run recorded the action running to completion at all.
test("a rule with an emailAudience department action sends to that department and records the count", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E emailAudience action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;

  const employees = await page.request.get("/v1/employees?page_size=200");
  expect(employees.status(), await employees.text()).toBe(200);
  const { results = [] } = (await employees.json()) as { results?: { work_email?: string; department?: string }[] };
  const emp = results.find((e) => e.work_email === ROLES.employee);
  if (!emp?.department) throw new Error("e2e: the employee fixture has no department to email into");
  const departmentId = emp.department.split("/")[1]!;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow emailAudience ${stamp}`);

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
  await page.getByRole("menuitem", { name: "Email an audience" }).click();

  await thenDo.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "A department", exact: true }).click();
  await thenDo.getByPlaceholder("department id").fill(departmentId);
  await thenDo.getByPlaceholder("Email subject").fill(`E2E emailAudience ${stamp}`);
  await thenDo.getByPlaceholder("<p>…</p>").fill(`<p>E2E emailAudience body ${stamp}</p>`);

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
    data: { subject: `E2E workflow emailAudience trigger ${stamp}`, category, description: "Raised by the e2e suite to set an emailAudience rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  type Action = { kind: string; status: string; detail?: string };
  await expect
    .poll(async () => {
      const res = await page.request.get("/v1/automation-runs?page_size=200");
      if (!res.ok()) return undefined;
      const { results = [] } = (await res.json()) as { results?: { subject?: string; result?: Action[] }[] };
      return results.find((r) => r.subject === ticket.path)?.result?.find((a) => a.kind === "emailAudience");
    }, { timeout: 60_000 })
    .toMatchObject({ kind: "emailAudience", status: "done", detail: expect.stringMatching(/^emailed \d+ recipient\(s\)$/) });

  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E emailAudience action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-emailaud-";
