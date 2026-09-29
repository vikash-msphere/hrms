import { gotoRoute, personId, test, expect } from "./fixtures";

// Walking the directory one record at a time.
//
// The employee record carries a pager - "N of M", an arrow either side - built entirely in the browser from
// the cached employees collection: no request, no server order, just the list the app already holds and the
// position of the record being read in it. That makes it exactly the kind of thing nothing else can check.
// `test/` never builds the list; `everyPage` opens one record and stops; `directory` proves search finds a
// person past the first page but never steps off the record it lands on.
//
// What only a browser shows: pressing an arrow really moves to the NEIGHBOUR (a different record, one place
// along the counter), the way out goes back to the directory, and the pager does not offer a step off either
// end of the list.
test("the record pager steps to the neighbour, and the way back is the directory", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const id = await personId(page, "employee");
  await gotoRoute(page, `employees/${id}`);

  // The counter is the pager's own state, and reading it is how the step below is checked without assuming
  // anything about who the seed happens to put either side of this person. `.first()`: "n of m" is a shape
  // other panels use too (the activity feed's detail stepper), and only this one is on the Profile tab.
  const counter = page.getByText(/^\d+ of \d+$/).first();
  await expect(counter).toBeVisible({ timeout: 30_000 });
  const total = Number((await counter.innerText()).split(" of ")[1]);
  expect(total, "a pager needs a list to page through").toBeGreaterThan(1);
  const self = (await page.getByRole("heading", { level: 1 }).innerText()).trim();

  const next = page.getByRole("button", { name: "Next employee" });
  const previous = page.getByRole("button", { name: "Previous employee" });
  // Which way to step is decided from the pager itself: a person at either end of the list has one arrow
  // disabled, and that is the pager being right rather than a failure.
  const forward = await next.isEnabled();
  const step = forward ? next : previous;
  const back = forward ? previous : next;
  await expect(step).toBeEnabled();
  // The arrow names who it goes to. That, not the counter, is what "the neighbour" is checked against: the
  // counter is a POSITION in the whole directory, and the specs alongside this one hire and remove "E2E ..."
  // people who sort ahead of the seeded ones, so a position read before the press has moved by the time the
  // record opens ("8 of 100" stepped to "8 of 104"). Who is either side of whom does not move with them.
  const neighbour = (await step.getAttribute("title"))?.trim();
  expect(neighbour, "the arrow names the person it steps to").toBeTruthy();
  await step.click();

  // A different record, and the one the arrow named - and from there, the arrow back names where it came from.
  await expect.poll(() => page.url()).not.toContain(`/employees/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(neighbour!, { timeout: 30_000 });
  await expect(counter).toBeVisible({ timeout: 30_000 });
  await expect(back).toHaveAttribute("title", self, { timeout: 30_000 });

  // And back, which is the same arrow the other way round.
  await back.click();
  await expect.poll(() => page.url()).toContain(`/employees/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(self, { timeout: 30_000 });

  // The pager is a detour, not a dead end: the record says how to get back to the list it came from.
  await page.getByRole("button", { name: "Back to directory" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });
});
