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
  const [at, total] = (await counter.innerText()).split(" of ").map(Number) as [number, number];
  expect(total, "a pager needs a list to page through").toBeGreaterThan(1);

  const next = page.getByRole("button", { name: "Next employee" });
  const previous = page.getByRole("button", { name: "Previous employee" });
  // Which way to step is decided from the pager itself: a person at either end of the list has one arrow
  // disabled, and that is the pager being right rather than a failure.
  const forward = await next.isEnabled();
  const step = forward ? next : previous;
  await expect(step).toBeEnabled();
  await step.click();

  // A different record, one place along - the two halves of "this arrow went to the neighbour". Read off the
  // one counter rather than matched as text, because the pager's wrapper carries the same words as the span
  // inside it and both would match.
  await expect.poll(() => page.url()).not.toContain(`#/employees/${id}`);
  await expect(counter).toHaveText(`${at + (forward ? 1 : -1)} of ${total}`, { timeout: 30_000 });

  // And back, which is the same arrow the other way round.
  await (forward ? previous : next).click();
  await expect.poll(() => page.url()).toContain(`#/employees/${id}`);
  await expect(counter).toHaveText(`${at} of ${total}`, { timeout: 30_000 });

  // The pager is a detour, not a dead end: the record says how to get back to the list it came from.
  await page.getByRole("button", { name: "Back to directory" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });
});
