import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Triage: who owns this, whose queue is it in, and how much does it matter.
//
// Three controls sit side by side on a ticket, each its own verb with its own grant (`assign`, `route`,
// `prioritize`) - which is why they are three controls and not one edit form. Each writes the moment it is
// picked and reads back off the ticket, and getting any of them wrong is how a ticket is silently parked in a
// queue nobody watches.
//
// `tickets` covers raising one and its status machine; `ticketWork` the conversation and the checklist;
// `test/ticketRouting.test.ts` owns the routing rules. What only a browser shows is this row of pickers: that
// each one commits on its own, and that what the drawer says afterwards is what the server holds.
test("a ticket is assigned, routed and prioritised from its own drawer", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const admin = await as("super"); // the hard purge is an admin's to make
  const subject = `E2E triage ${Date.now() % 1_000_000}`;

  const created = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { category: "it", subject, description: "Raised by the triage spec.", priority: "low" },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;
  const department = await someDepartment(page);

  try {
    // Straight to the ticket: `#/tickets/<id>` is the link a notification and a copied URL both hand out, and
    // it opens the drawer these controls live in.
    await gotoRoute(page, `tickets/${path.split("/")[1]}`);
    const drawer = page.getByRole("dialog").filter({ hasText: subject });
    await expect(drawer).toBeVisible({ timeout: 30_000 });

    // Owner. The picker is the shared combobox, so the person is searched for rather than scrolled to.
    await drawer.getByLabel("Assignee").click();
    await page.getByPlaceholder("Search people…").fill("Eve");
    await page.getByRole("option", { name: "Eve Employee" }).first().click();
    await expect.poll(() => field(page, path, "assignee"), { timeout: 30_000 }).toBeTruthy();

    // Queue. Routing is the one that decides who ever looks at this again.
    await drawer.getByLabel("Department", { exact: true }).click();
    await page.getByPlaceholder("Search departments…").fill(department.name);
    await page.getByRole("option", { name: department.name }).first().click();
    await expect.poll(() => field(page, path, "department"), { timeout: 30_000 }).toBe(department.path);

    // How much it matters, which is a different grant again.
    await drawer.getByLabel("Priority").click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await expect.poll(() => field(page, path, "priority"), { timeout: 30_000 }).toBe("high");

    // And the drawer agrees from cold: the three writes are on the ticket, not in the page's copy of it.
    await page.reload();
    const reopened = page.getByRole("dialog").filter({ hasText: subject });
    await expect(reopened).toBeVisible({ timeout: 30_000 });
    await expect(reopened.getByLabel("Assignee")).toContainText("Eve Employee");
    await expect(reopened.getByLabel("Department", { exact: true })).toContainText(department.name);
  } finally {
    await purge(admin, path);
  }
});

/** One of the org's departments, to route into. */
async function someDepartment(page: import("@playwright/test").Page): Promise<{ path: string; name: string }> {
  const res = await page.request.get("/v1/departments?page_size=50");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string; delete_time?: string }[] };
  const dept = results.find((d) => !d.delete_time && d.display_name);
  if (!dept) throw new Error("e2e: the org has no department to route a ticket into");
  return { path: dept.path, name: dept.display_name! };
}

/** One field of the ticket, as the server holds it. */
async function field(page: import("@playwright/test").Page, path: string, key: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return (await res.json())[key];
}
