import { gotoRoute, inDays, purge, toast, expect, test } from "./fixtures";

// A company event, and answering the invitation.
//
// The event is a row; the browser-only half is the RSVP - a three-way answer given from the row, beside the
// count it changes, which then has to read back. An invitation nobody can answer, or one that forgets the
// answer, is the whole feature broken, and neither shows up in a server test where the verb works fine.
//
// Who may answer is policy, not UI: everyone reads the calendar (`events.**: read` in the base grants), but
// `respond` is a custom method and the seeded policy hands the events verbs to HR and super. So HR answers
// here, and the employee's side asserts the other half of hide-never-disable: they can see the event and are
// NOT offered an answer they would be refused.
test("an event is created, HR answers it, and the count moves", async ({ as }) => {
  const organiser = await as("hr");
  const employee = await as("employee");
  const title = `E2E event ${Date.now()}`;

  await gotoRoute(organiser, "events", "Events");
  await organiser.getByRole("button", { name: "New event" }).first().click();
  const form = organiser.getByRole("dialog");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Start date").fill(inDays(14));
  await form.getByRole("button", { name: "Create event" }).click();
  await expect(toast(organiser, "Event created")).toBeVisible();

  const row = organiser.locator("tbody tr").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("0 going");

  // The answer sits on the row, next to the count it is about to change.
  await row.getByRole("button", { name: "Going", exact: true }).click();
  await expect(toast(organiser, "You're going")).toBeVisible();
  await expect(row).toContainText("1 going");

  // The employee sees the event on the shared calendar, and is offered no answer to give.
  await gotoRoute(employee, "events", "Events");
  const theirRow = employee.locator("tbody tr").filter({ hasText: title });
  await expect(theirRow).toHaveCount(1);
  await expect(theirRow.getByRole("button", { name: "Going", exact: true })).toHaveCount(0);

  await purge(organiser, await eventPath(organiser, title));
});

/** The wire path of the event this spec created. */
async function eventPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/events?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[] };
  const row = results.find((e) => (e.title ?? e.display_name) === title);
  if (!row) throw new Error(`e2e: the event "${title}" is not in the collection`);
  return row.path;
}
