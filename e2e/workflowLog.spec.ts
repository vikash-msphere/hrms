import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The read-only half of Workflows: what the automation engine actually did.
//
// `workflows.spec.ts` composes a rule. The other three tabs are the record - the runs a rule produced, the
// durable workflows parked on a "wait for" step, and the event log every action announces itself to. They are
// the surface an admin opens when an automation did not do what they expected, and they are three different
// lazy reads (`automation-runs`, `workflow-instances`, `event-log`) which nothing else in the lane opens: a
// tab that throws on mount, or that shows a spinner forever because its read is wrong, is invisible until
// somebody goes looking on a bad day.
//
// What is asserted beyond "it rendered" is the event log doing its one job: an action taken NOW appears in it
// on the next read, which is the feed the rules react to.
test("the log tabs render, and an action taken now shows up in the event log", async ({ as }) => {
  test.setTimeout(180_000);
  // `automations.read` is an admin capability, and the event log is every module's events at once.
  const page = await as("super");
  const subject = `E2E event ${Date.now()}`;

  await gotoRoute(page, "workflows", "Workflows");

  // Runs, and Waiting: either a record or the honest empty state that says what would be here. Both are a
  // read of their own, and "Could not load" is the failure this walks into.
  await page.getByRole("button", { name: "Runs" }).click();
  await expect(page.getByText("Could not load runs")).toHaveCount(0);
  await expect(page.getByText(/No runs yet|Refresh/).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Waiting" }).click();
  await expect(page.getByText("Could not load waiting workflows")).toHaveCount(0);
  await expect(page.getByText(/Nothing waiting|Refresh/).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Event log" }).click();
  await expect(page.getByText("Could not load events")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible({ timeout: 30_000 });

  // Something happens, elsewhere in the app.
  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject, category: "it", description: "Raised by the e2e suite to announce itself on the bus." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  // And the log has it on the next read - fetched by the tab's own Refresh rather than by reloading the page,
  // which is the affordance an admin watching an automation actually uses.
  await page.getByRole("button", { name: "Refresh" }).click();
  // Named by what happened, not by its wire type - the log is read by people, so `ticket.created` is drawn
  // as the event's own label with its module's colour.
  await expect(page.getByText("Ticket created").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("just now").first()).toBeVisible({ timeout: 30_000 });

  await purge(page, ticket.path);
});
