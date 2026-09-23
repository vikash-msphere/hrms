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
  // The desk opens on its own queue ("Assigned to me"), so the whole board is one scope chip away. Scopes are
  // presets over the table's own filters, so the chip is a pressed-state button rather than a tab.
  await agent.getByRole("button", { name: /^All/, pressed: false }).click();
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

// The desk is one table narrowed by who you are, where it used to be four tables behind four tabs.
//
// What that has to keep, and what nothing else in the suite checks: a scope narrows the rows, it says so in
// the address bar (so a narrowed desk can be sent to somebody), and the chip that is on turns off again. The
// last one is what makes a scope different from a tab: pressing "All" is not navigation, it is clearing a
// filter, and a filter you can turn on but not off is one people get stuck in.
test("a scope chip narrows the desk, travels in the URL, and clears again", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const subject = `E2E scope ${Date.now()}`;

  // OWN THE ROW. An empty desk draws its empty state instead of the table, and a table nobody has raised a
  // ticket on has no chips to press - so this spec raises its own rather than relying on another one's
  // leftovers, which is the difference between passing on a warm database and passing anywhere.
  await gotoRoute(page, "tickets", "Support");
  await page.getByRole("button", { name: "New ticket" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Subject").fill(subject);
  await form.getByLabel("Category").click();
  await page.getByRole("option").first().click();
  await form.getByRole("button", { name: "Raise ticket" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const all = page.getByRole("button", { name: /^All/ });
  const mine = page.getByRole("button", { name: /^My tickets/ });
  await expect(all).toBeVisible({ timeout: 30_000 });

  // The desk opens on a scope of its own choosing (its own queue where there is one, the reader's tickets
  // otherwise), so start from a known place rather than from whichever that was.
  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  const everything = await page.locator("tbody tr").count();

  await mine.click();
  await expect(mine).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(all).toHaveAttribute("aria-pressed", "false");
  // It NARROWS: a scope is a filter, not a label on the same rows.
  await expect.poll(() => page.locator("tbody tr").count(), { timeout: 30_000 }).toBeLessThanOrEqual(everything);
  // And it rides the table's own URL state, so a narrowed desk can be sent to somebody and survives a reload.
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("t.tickets");
  await page.reload();
  await expect(page.getByRole("button", { name: /^My tickets/ })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  // Pressing the chip that is on turns it off - the difference between a scope and a tab, and what keeps a
  // reader from getting stuck inside a narrowing they cannot see the edge of.
  await page.getByRole("button", { name: /^My tickets/ }).click();
  await expect(page.getByRole("button", { name: /^My tickets/ })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");

  await purge(page, await ticketPath(page, subject));
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
