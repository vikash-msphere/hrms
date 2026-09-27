import { SPA_HEADERS, ROLES, gotoRoute, landedResponse, purge, test, expect } from "./fixtures";
import { addTicketCategory, dropTicketCategories } from "./ticketCategories";

// "Broadcast to an audience" - never composed through the builder before this, and its "Specific employees"
// mode has no picker anywhere in ActionList.tsx (flagged separately as a product gap), so this exercises the
// one audience mode that IS fully wired: "A department". Scoped to the employee fixture's OWN department so
// the broadcast reaches exactly one real, known person rather than the whole seeded org.
test("a rule with a notifyAudience department action reaches that department's members", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const ruleName = `E2E notifyAudience action ${stamp}`;
  const category = `${CATEGORY_PREFIX}${stamp}`;
  const title = `E2E broadcast ${stamp}`;

  const employees = await page.request.get("/v1/employees?page_size=200");
  expect(employees.status(), await employees.text()).toBe(200);
  const { results = [] } = (await employees.json()) as { results?: { work_email?: string; department?: string }[] };
  const emp = results.find((e) => e.work_email === ROLES.employee);
  if (!emp?.department) throw new Error("e2e: the employee fixture has no department to broadcast into");
  // The builder names departments, it does not ask for their ids - so the fixture's department is resolved
  // to the name the picker will list it under.
  const dept = await page.request.get(`/v1/${emp.department}`);
  expect(dept.status(), await dept.text()).toBe(200);
  const departmentName = ((await dept.json()) as { display_name: string }).display_name;

  await gotoRoute(page, "workflows", "Workflows");
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
  await addTicketCategory(page, category, `E2E workflow notifyAudience ${stamp}`);

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
  await page.getByRole("menuitem", { name: "Broadcast to an audience" }).click();

  await thenDo.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "A department", exact: true }).click();
  await thenDo.getByRole("combobox", { name: "Department" }).click();
  await page.getByRole("option", { name: departmentName, exact: true }).click();
  await thenDo.getByPlaceholder("Notification title").fill(title);

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
    data: { subject: `E2E workflow notifyAudience trigger ${stamp}`, category, description: "Raised by the e2e suite to set a notifyAudience rule off." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  const employee = await as("employee");
  let notificationPath: string | undefined;
  await expect
    .poll(async () => {
      const res = await employee.request.get("/v1/notifications?page_size=50");
      if (!res.ok()) return false;
      const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
      const found = results.find((n) => n.title === title);
      notificationPath = found?.path;
      return !!found;
    }, { timeout: 60_000 })
    .toBe(true);

  if (notificationPath) await purge(employee, notificationPath);
  await purge(page, ticket.path);
  await sweepRules(page);
  await dropTicketCategories(page, CATEGORY_PREFIX);
});

type Page = import("@playwright/test").Page;

async function sweepRules(page: Page) {
  const res = await page.request.get("/v1/automations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => (x.name ?? "").startsWith("E2E notifyAudience action "))) await purge(page, r.path);
}

const CATEGORY_PREFIX = "e2e-wf-aud-";
