import { gotoRoute, inDays, purge, test, expect } from "./fixtures";

// Inviting a room full of people without picking them one at a time.
//
// An event's attendee list is built in the composer, and the control people actually use is "add a whole
// department" - a dozen names in one press, expanded in the BROWSER into named attendees rather than stored
// as "the engineering department" (people move teams; an invitation should not follow them). Each name then
// arrives as its own removable chip, which is what makes the list reviewable before it goes out.
//
// `events` covers the RSVP on the row and who is allowed to answer. `test/` owns the record. What only a
// browser shows is the composition: the department expanding into people, a name taken back out again, and
// the attendees landing on the event that is saved.
test("a whole department is invited in one press, and a name can be taken back out", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const admin = await as("super"); // the hard purge is an admin's to make
  const title = `E2E invite ${Date.now() % 1_000_000}`;

  await gotoRoute(page, "events", "Events");
  await page.getByRole("button", { name: "New event" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByText("New event")).toBeVisible({ timeout: 30_000 });

  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Start date").fill(inDays(14));

  // Nothing invited yet, and the form says so rather than showing an empty box.
  await expect(form.getByText("No attendees yet.")).toBeVisible();

  // The one press that fills a room. The picker is a Select whose placeholder names what it does - and only
  // offers departments that actually have somebody directly in them (Events.tsx), so the first option is
  // always one that expands into at least one person.
  await form.getByRole("combobox").filter({ hasText: "Add a whole department…" }).first().click();
  const department = page.getByRole("option").first();
  const departmentName = ((await department.textContent()) ?? "").trim();
  expect(departmentName.length, "no department was offered to invite").toBeGreaterThan(0);
  await department.click();

  // Named people, not "the department": each is its own chip with its own way out, which is what makes the
  // list something an organiser can check.
  await expect(form.getByText("No attendees yet.")).toHaveCount(0, { timeout: 30_000 });
  const remove = form.getByRole("button", { name: /^Remove / });
  const invited = await remove.count();
  expect(invited, `inviting ${departmentName} added nobody`).toBeGreaterThan(0);

  // One of them taken back out - the department is a shortcut, not a commitment.
  await remove.first().click();
  await expect(remove).toHaveCount(invited - 1);

  await form.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    // The invitation is on the record, with exactly the people left on the form - not the department, and not
    // the name that was removed.
    await expect.poll(() => attendeeCount(page, title), { timeout: 30_000 }).toBe(invited - 1);
  } finally {
    const path = await eventPath(page, title);
    if (path) await purge(admin, path);
  }
});

/** How many people this event ended up inviting, as the server holds it. */
async function attendeeCount(page: import("@playwright/test").Page, title: string): Promise<number> {
  const res = await page.request.get("/v1/events?page_size=100");
  if (!res.ok()) return -1;
  const { results = [] } = (await res.json()) as { results?: { title?: string; attendees?: string[] }[] };
  return (results.find((e) => e.title === title)?.attendees ?? []).length;
}

/** The wire path of the event this spec created. */
async function eventPath(page: import("@playwright/test").Page, title: string): Promise<string | undefined> {
  const res = await page.request.get("/v1/events?page_size=100");
  if (!res.ok()) return undefined;
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  return results.find((e) => e.title === title)?.path;
}
