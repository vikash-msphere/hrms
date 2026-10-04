import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// Booking the next 1:1 without losing what was left over from the last one.
//
// The point of a 1:1 series is continuity: whatever was not finished last time is what the next meeting
// starts from. "Schedule next" is where that happens, and it happens entirely in the browser - the composer
// is opened pre-filled with the same counterpart, a date a week out, and the action items that are still
// OPEN, while the ones already ticked are deliberately left behind.
//
// `checkIns` covers the cadence preview and the 1:1 reaching the other person. `test/checkInRecurrence.test.ts`
// owns the stepping. What only a browser shows is this carry: a form that opened blank would quietly drop
// everything the last meeting agreed, and nothing outside the page could tell.
test("scheduling the next 1:1 carries the unfinished items and leaves the done ones", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("employee");
  const admin = await as("super"); // the hard purge is an admin's to make
  const stamp = Date.now() % 1_000_000;
  const carried = `E2E open item ${stamp}`;
  const finished = `E2E done item ${stamp}`;

  // A meeting that has already happened, with one thing done and one not - composed over the wire, since the
  // composer itself is `checkIns`' subject.
  const created = await page.request.post("/v1/check-ins", {
    headers: SPA_HEADERS,
    data: {
      employee: await personPath(page, "employee"),
      // Looked up through the ADMIN's browser: an employee's directory is themselves, so asking this page
      // for the manager's record finds nothing and the spec dies on its own setup.
      counterpart: await personPath(admin, "manager"),
      meeting_date: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
      notes: "Raised by the schedule-next spec.",
      action_items: [
        { text: carried, done: false },
        { text: finished, done: true },
      ],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const original = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "check-ins", "1:1s");
    // Searched for rather than scrolled to: past 1:1s are shown a handful at a time, and a meeting a week old
    // sits behind that cutoff as soon as this person has had a few. Searching lifts the cutoff and matches on
    // action-item text, which is what makes this run's meeting findable at all.
    await page.getByRole("searchbox", { name: "Search notes and action items…" }).fill(carried);
    // The collapsed card counts the open items ("1 open") rather than listing them, so the meeting has to be
    // unfolded before its checklist - and the "Schedule next" affordance beside it - are on screen at all.
    const card = page.getByRole("button").filter({ hasText: "Raised by the schedule-next spec." }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    await expect(page.getByText(carried).first()).toBeVisible({ timeout: 30_000 });

    // The affordance sits on a past meeting's card - it is what you press when the meeting is over.
    await page.getByRole("button", { name: /Schedule next/ }).first().click();
    const form = page.getByRole("dialog");
    await expect(form).toBeVisible({ timeout: 30_000 });

    // Carrying the series: a date in the future and the thing that is still open. The counterpart is carried
    // as the FORM'S DEFAULT rather than as a name in the box - blank means "your manager", which is who this
    // series is with - so who it ends up with is asserted on the saved record below rather than on a
    // placeholder.
    const date = await form.getByLabel("Meeting date").inputValue();
    expect(date > new Date().toISOString().slice(0, 10), `the next meeting is dated ${date}`).toBe(true);
    // The form states the carry rather than listing it - one line, counting what is coming across, which is
    // what somebody reads before pressing. That it is ONE item (not two) is the assertion: the finished one
    // is being left behind, and a checklist that never shrinks is a checklist nobody reads.
    await expect(form.getByText(/^Carries 1 open action item forward from the last 1:1/)).toBeVisible();
    await expect(form.getByText(finished)).toHaveCount(0);

    // The submit says which of the two things this is - a meeting in the future is scheduled, one in the past
    // is logged - so the label is part of what the pre-filled date means.
    await form.getByRole("button", { name: "Schedule 1:1" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // Two meetings now, and the open item is on the new one - which is what makes the series continuous.
    await expect.poll(() => withItem(page, carried), { timeout: 30_000 }).toHaveLength(2);
    // And the finished one stayed where it was: still on one meeting, not copied onto the next.
    await expect.poll(() => withItem(page, finished), { timeout: 30_000 }).toHaveLength(1);
    // And it is the same series: the next meeting is with the same person as the last one.
    const [a, b] = await counterparts(page, carried);
    expect(b, "the next 1:1 is with somebody else").toBe(a);
  } finally {
    for (const c of await withItem(page, carried)) await purge(admin, c);
    await purge(admin, original);
  }
});

/** Who each check-in carrying this item is with, oldest first. */
async function counterparts(page: import("@playwright/test").Page, text: string): Promise<(string | undefined)[]> {
  const res = await page.request.get("/v1/check-ins?page_size=200");
  if (!res.ok()) return [];
  const { results = [] } = (await res.json()) as {
    results?: { counterpart?: string; meeting_date?: string; action_items?: { text?: string }[] }[];
  };
  return results
    .filter((c) => (c.action_items ?? []).some((i) => i.text === text))
    .sort((x, y) => (x.meeting_date ?? "").localeCompare(y.meeting_date ?? ""))
    .map((c) => c.counterpart);
}

/** Check-ins carrying an action item with this text. */
async function withItem(page: import("@playwright/test").Page, text: string): Promise<string[]> {
  const res = await page.request.get("/v1/check-ins?page_size=200");
  if (!res.ok()) return [];
  const { results = [] } = (await res.json()) as { results?: { path: string; action_items?: { text?: string }[] }[] };
  return results.filter((c) => (c.action_items ?? []).some((i) => i.text === text)).map((c) => c.path);
}
