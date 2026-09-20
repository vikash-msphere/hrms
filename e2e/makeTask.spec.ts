import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// "This tick-box turned out to be work."
//
// The same move is offered from three places - a 1:1 action item, a checklist item on a task, a checklist
// item on a support ticket - and it is deliberately ONE-WAY: the new task carries a line saying where it came
// from, and the item it came from stays where it is, because deleting somebody's checklist item to "move" it
// loses the context they were reading it in.
//
// Nothing outside a browser can see that: the promotion is a dialog seeded from a row in a side table on
// another page, its board picker is a lazy read that only happens while the dialog is open, and the two facts
// that make it honest (the task's description names the ticket, the ticket's item is still ticked-off-able)
// live on two different pages.
test("a ticket's checklist item is promoted to a board task, and stays on the ticket", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const stamp = Date.now();
  const subject = `E2E promote ${stamp}`;
  const item = `E2E do the thing ${stamp % 100000}`;

  // The seed ships no boards, so this spec brings the one it files onto - and takes it away again, because
  // every board is visible to every other spec that opens the page.
  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E promote board ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string; name: string };
  const boardId = board.path.split("/")[1]!;

  // Raised over the wire: filing a ticket is `tickets.spec.ts`'s subject.
  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject, category: "it", description: "Raised by the e2e suite, to have an item promoted off it." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  await gotoRoute(page, "tickets", "Support");
  // A BUTTON, not a tab. The scope switcher on this page renders its choices as buttons (Tickets.tsx
  // `allScope`), so `getByRole("tab")` matched nothing and this waited out its timeout - a spec that had gone
  // stale against the page rather than a page that had broken.
  // Matched by prefix because the control carries a "new since you last looked" count in its accessible name.
  await page.getByRole("button", { name: /^All/ }).click();
  await page.locator("tbody tr").filter({ hasText: subject }).first().click();
  const detail = page.getByRole("dialog");
  const add = detail.getByPlaceholder("Add a checklist item…");
  await add.fill(item);
  await add.press("Enter");
  await expect(detail.getByText(item)).toBeVisible({ timeout: 30_000 });

  // The affordance is on the item itself - the decision "this is bigger than a tick-box" is made while
  // looking at the line, not from a menu at the top of the ticket.
  const row = detail.locator("div").filter({ hasText: item }).last();
  await row.getByRole("button", { name: "Make this a board task" }).click();

  const form = page.getByRole("dialog").filter({ hasText: "Make a board task" });
  // Seeded from the line: the title is the item's own words, so the common case is press-and-done.
  await expect(form.getByLabel("Title")).toHaveValue(item);
  // And the form SHOWS the trace it is about to write, rather than describing it - it is the only thing
  // connecting the task back to the ticket.
  await expect(form.getByText(`The task's description will read: From support ticket: ${subject}`)).toBeVisible();

  // Boards are read only while this dialog is open, so the picker's options are the proof of that read. It
  // is the app's shared Combobox (`combobox.spec.ts` owns its behaviour): a trigger named by its label, a
  // search box, and the rows as buttons.
  // The list is a portal at the page root, not a child of the dialog - so it is reached from the page.
  await form.getByLabel("Board").click();
  await page.getByPlaceholder("Search boards…").fill(board.name);
  await page.getByRole("option", { name: board.name }).click();
  await form.getByRole("button", { name: "Create task" }).click();
  // The write dialog closes on a successful write and pins the reason on a failed one, so a dialog still
  // open here IS the failure.
  await expect(page.getByRole("dialog").filter({ hasText: "Make a board task" })).toHaveCount(0, { timeout: 30_000 });

  // One-way: the item is still on the ticket. A promotion that quietly removed it would lose the context the
  // requester is reading the checklist in.
  const stillThere = page.getByRole("dialog").filter({ hasText: subject });
  await expect(stillThere.getByText(item)).toBeVisible();

  // And on the board: the task is really there, with the line pointing back at the ticket.
  const card = await promotedCard(page, boardId, item);
  await gotoRoute(page, `boards?board=${boardId}`);
  await expect(page.getByText(item).first()).toBeVisible({ timeout: 30_000 });
  await page.getByText(item).first().click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByText(`From support ticket: ${subject}`).first()).toBeVisible({ timeout: 30_000 });
  await editor.getByRole("button", { name: "Close" }).first().click();

  await purge(page, card);
  await purge(page, board.path);
  await purge(page, ticket.path);
});

/** The wire path of the task the promotion created, by the title it carried over. */
async function promotedCard(page: import("@playwright/test").Page, boardId: string, title: string): Promise<string> {
  const res = await page.request.get(`/v1/cards?page_size=200&board=boards/${boardId}`);
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  const card = results.find((c) => c.title === title);
  if (!card) throw new Error(`e2e: the promoted task "${title}" is not on the board`);
  return card.path;
}
