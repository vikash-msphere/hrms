import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// Asking the company a question, and counting the answers.
//
// A poll is an announcement with options, and both halves are browser-only. Composing one is a mode switch
// that re-shapes the form (a title becomes the question, and two option rows appear that grow as they are
// filled), and voting is the one write in the app with no dialog and no save button: pressing an option IS
// the vote, and the bars have to move under it. The tallies live in `announcement_poll_votes` and are read
// off the announcement, which is the roll-up that goes stale when a write does not stamp its parent
// (src/db/changeDdl.ts) - so this also proves a fresh reader sees the count the voter cast.
test("a poll is posted, voted on, and the tally moves", async ({ as }) => {
  test.setTimeout(180_000);
  const hr = await as("hr");
  const employee = await as("employee");
  const stamp = Date.now();
  const question = `E2E poll ${stamp}`;
  // The shared board: a whole family of specs post, edit and delete on the SAME feed this page renders, org-
  // wide and unscoped to this test's own row - a 404 landing on a background refetch for a post another one
  // of them just took out from under this page's own poll is that collision, not this spec's own doing.
  allowConsoleErrors(hr, /status of 404/i);
  allowConsoleErrors(employee, /status of 404/i);

  await gotoRoute(hr, "announcements", "Feed");
  // The post button is a split button: its main half writes the org's default kind, and the chevron picks
  // another. One composer, re-shaped by the kind - which is why a poll has no "new poll" page of its own.
  await hr.getByRole("button", { name: "Choose what to post" }).click();
  await hr.getByRole("menuitem", { name: "Poll" }).click();
  const composer = hr.getByRole("dialog");

  // The question, and two answers - the minimum a poll can be, which is why the form starts with exactly two
  // option rows.
  await composer.getByPlaceholder(/What do|question/i).first().fill(question);
  await composer.getByPlaceholder("Option 1").fill("Tea");
  await composer.getByPlaceholder("Option 2").fill("Coffee");
  await composer.getByRole("button", { name: "Post poll" }).click();
  await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const card = hr.locator("div").filter({ hasText: question }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The vote, by the person being asked: no dialog, no save - the option IS the button.
  await gotoRoute(employee, "announcements", "Feed");
  const theirs = employee.locator("div").filter({ hasText: question }).last();
  await expect(theirs).toBeVisible({ timeout: 30_000 });
  await theirs.getByRole("button", { name: /Coffee/ }).first().click();

  // Voting turns the options into a result: their own answer is marked, and the tally counts it.
  await expect(theirs.getByText(/1 vote|100%/).first()).toBeVisible({ timeout: 30_000 });

  // And the asker sees the same number, from cold - a tally that only the voter's own browser knows is not a
  // poll result.
  await hr.reload();
  await expect(hr.getByRole("main")).toBeVisible();
  const asked = hr.locator("div").filter({ hasText: question }).last();
  await expect(asked.getByText(/1 vote|100%/).first()).toBeVisible({ timeout: 30_000 });

  await purgeNamed(hr, question);
});

/** Drop the poll this spec posted. */
async function purgeNamed(page: import("@playwright/test").Page, title: string) {
  const res = await page.request.get("/v1/announcements?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  for (const a of results.filter((x) => x.title === title)) await purge(page, a.path);
}
