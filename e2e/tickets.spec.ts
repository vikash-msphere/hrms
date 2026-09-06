import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A support ticket, raised and worked.
//
// The help desk is where the app talks to itself: a ticket is raised on one person's screen and worked by
// the desk its category routes it to. `test/ticketRouting.test.ts` and `test/ticketWorkflowDrift` own the
// routing and the state graph. What only a browser shows is the desk itself - the raise form warning about a
// duplicate the requester already has open (the thing that actually clogs a queue), and the status control,
// which is not a set of verb buttons but a menu of STATES that says, for each one, whether this ticket can
// go there from where it is and why not.
test("a ticket is raised, warns about a duplicate, and is moved through its states", async ({ as }) => {
  test.setTimeout(120_000);
  const requester = await as("employee");
  const agent = await as("hr");
  const subject = `E2E ticket ${Date.now()}`;

  await gotoRoute(requester, "tickets", "Support");
  await requester.getByRole("button", { name: "New ticket" }).first().click();
  const form = requester.getByRole("dialog");
  await form.getByLabel("Subject").fill(subject);
  await form.getByLabel("Category").click();
  await requester.getByRole("option").first().click();
  await form.getByRole("button", { name: "Raise ticket" }).click();
  await expect(requester.getByRole("dialog")).toHaveCount(0);
  await expect(requester.getByText(subject).first()).toBeVisible();

  // The duplicate guard: the same subject again is warned about, not blocked - a second identical ticket is
  // usually a forgotten first one.
  await requester.getByRole("button", { name: "New ticket" }).first().click();
  const again = requester.getByRole("dialog");
  await again.getByLabel("Subject").fill(subject);
  await expect(again.getByText(/already have a ticket with this subject/)).toBeVisible();
  await requester.keyboard.press("Escape");
  const discard = requester.getByRole("dialog");
  const discardBtn = discard.getByRole("button", { name: /Discard|Leave/ });
  if (await discardBtn.count()) await discardBtn.first().click();

  // The desk picks it up. The status control names where the ticket IS and offers where it can go.
  await gotoRoute(agent, "tickets", "Support");
  // The desk opens on its own queues ("Assigned to me"), so the whole board is a tab away.
  await agent.getByRole("tab", { name: /^All/ }).click();
  const row = agent.locator("tbody tr").filter({ hasText: subject });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: /^Status: / }).click();
  await expect(agent.getByText("Move this ticket to")).toBeVisible();
  await agent.getByRole("menuitem", { name: /In progress/ }).click();
  await expect(toast(agent, /Moved to In progress/)).toBeVisible();

  // And on to resolved, which is the state that hands it back to the requester to confirm.
  await row.getByRole("button", { name: /^Status: / }).click();
  await agent.getByRole("menuitem", { name: /Resolved/ }).click();
  await expect(toast(agent, /Moved to Resolved/)).toBeVisible();
  await expect(row).toContainText(/Resolved/i);

  await purge(agent, await ticketPath(agent, subject));
});

/** The wire path of the ticket this spec raised. */
async function ticketPath(page: import("@playwright/test").Page, subject: string): Promise<string> {
  const res = await page.request.get("/v1/tickets?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; subject?: string }[] };
  const row = results.find((t) => t.subject === subject);
  if (!row) throw new Error(`e2e: the ticket "${subject}" is not in the collection`);
  return row.path;
}
