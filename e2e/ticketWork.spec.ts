import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Working a ticket, rather than filing one.
//
// `tickets.spec.ts` covers raising one and moving it through its states. What happens in between is a
// conversation and a checklist, and both live in tables of their own (`ticket_comments`, `ticket_todos`) that
// roll up onto the ticket the requester is watching. That roll-up is exactly what goes stale: the rows are
// written to one table and read as a count on another, so a client holding a stored copy of `tickets` shows
// the old numbers unless the write stamps the parent (src/db/changeDdl.ts). Only a browser can see the whole
// chain - type a reply, tick an item, and have the ticket itself say so afterwards, from cold.
test("a ticket takes a checklist and a reply, and both survive a reload", async ({ as }) => {
  test.setTimeout(180_000);
  const hr = await as("hr");
  const stamp = Date.now();
  const subject = `E2E work ${stamp}`;
  const item = `E2E step ${stamp % 100000}`;
  const toRemove = `E2E gone ${stamp % 100000}`;
  const reply = `E2E reply ${stamp % 100000}`;

  // Raised over the wire: filing one is `tickets.spec.ts`'s subject, and this spec is about what happens to it
  // afterwards.
  const made = await hr.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    // The category is what routes a ticket to a desk, so it is required: "it" is one the org ships with.
    data: { subject, category: "it", description: "Raised by the e2e suite to be worked on." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  await gotoRoute(hr, "tickets", "Support");
  await hr.locator("tbody tr").filter({ hasText: subject }).first().click();

  // The checklist: what is left to do on this ticket, added one line at a time.
  const detail = hr.getByRole("dialog");
  await expect(detail.getByText(subject).first()).toBeVisible();
  const add = detail.getByPlaceholder("Add a checklist item…");
  await add.fill(item);
  await add.press("Enter");
  await expect(detail.getByText(item)).toBeVisible({ timeout: 30_000 });

  // Ticking one is a verb of its own (`toggleTodo`), so it is the tick - not a save button - that records it.
  const box = detail.getByRole("checkbox").first();
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked({ timeout: 30_000 });

  // Removal is a verb of its own too (`removeTodo`) - a second item added only to be deleted, so the first
  // one's done/reload assertions below stay about the item that survives.
  await add.fill(toRemove);
  await add.press("Enter");
  const removeRow = detail.locator("div").filter({ hasText: toRemove }).last();
  await expect(removeRow).toBeVisible({ timeout: 30_000 });
  await removeRow.getByRole("button", { name: "Remove" }).click();
  await expect(detail.getByText(toRemove)).toHaveCount(0, { timeout: 30_000 });

  // The reply: what the requester actually reads. Ctrl+Enter is the shortcut the field advertises.
  const composer = detail.getByPlaceholder(/Write a reply/);
  await composer.fill(reply);
  await detail.getByRole("button", { name: /^(Reply|Send|Comment)/ }).first().click();
  await expect(detail.getByText(reply)).toBeVisible({ timeout: 30_000 });

  // From cold, on the ticket itself: a comment and a tick that live only in the open dialog are a
  // conversation nobody else can see.
  // Opening a ticket writes its id into the hash, so a reload lands back ON the ticket rather than on the
  // list - which is the point of the deep link, and means there is nothing to click here.
  await hr.reload();
  const again = hr.getByRole("dialog");
  await expect(again.getByText(subject).first()).toBeVisible({ timeout: 30_000 });
  await expect(again.getByText(reply)).toBeVisible({ timeout: 30_000 });
  await expect(again.getByText(item)).toBeVisible();
  await expect(again.getByRole("checkbox").first()).toBeChecked();

  await purge(hr, ticket.path);
});
