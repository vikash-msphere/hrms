import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Re-routing a ticket to a different servicing department (`tickets:route`) - the department picker inside
// the ticket's own detail drawer, distinct from the requester's own department (the authz-relevant one) per
// the servicing-department design. Never exercised: no other spec touches this combobox at all.
test("a ticket is routed to a different department, and the change is saved", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
  const stamp = Date.now() % 1_000_000;
  const subject = `E2E route ${stamp}`;
  const deptLabel = `E2E route dept ${stamp}`;

  const madeDept = await hr.request.post("/v1/departments", {
    headers: SPA_HEADERS,
    data: { display_name: deptLabel },
  });
  expect(madeDept.status(), await madeDept.text()).toBe(200);
  const dept = (await madeDept.json()) as { path: string };

  const made = await hr.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject, category: "it", description: "Raised by the e2e suite to be re-routed." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  try {
    await gotoRoute(hr, "tickets", "Support");
    await hr.locator("tbody tr").filter({ hasText: subject }).first().click();
    const detail = hr.getByRole("dialog");
    await expect(detail.getByText(subject).first()).toBeVisible();

    // `Field label="Department" htmlFor="ticket-department"` names the combobox by id, not by DOM proximity -
    // getByLabel is what that pairing is for.
    const deptTrigger = detail.getByLabel("Department");
    await deptTrigger.click();
    await hr.getByPlaceholder("Search departments…").fill(deptLabel);
    await hr.getByRole("button", { name: new RegExp(`^${escapeRe(deptLabel)}`) }).click();

    await expect(toast(hr, "Department updated")).toBeVisible({ timeout: 30_000 });
    await expect(deptTrigger).toContainText(deptLabel);

    const reread = await hr.request.get(`/v1/${ticket.path}`);
    expect(reread.status(), await reread.text()).toBe(200);
    expect(((await reread.json()) as { department?: string }).department).toBe(dept.path);
  } finally {
    await purge(hr, ticket.path);
    await purge(hr, dept.path);
  }
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
