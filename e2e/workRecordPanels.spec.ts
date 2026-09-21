import { SPA_HEADERS, allowConsoleErrors, gotoRoute, personId, personPath, purge, test, expect } from "./fixtures";

// The panels that read the record back, and call no model to do it.
//
// WHY THEY ARE NOT IN `aiFeatures.spec.ts`. That file exists because the AI switches live in ONE org-wide
// settings blob, so two files asserting about them race each other. These panels have no switch: the review
// evidence pack and the goal blocking chains are queries and arithmetic over rows the app already holds, and
// they work on a deployment with no AI bindings at all. Keeping them out of that file keeps this one able to
// run in parallel with everything else, and says the thing that matters about them - there is nothing to
// switch on.
//
// WHAT ONLY A BROWSER SHOWS. `test/reviewEvidence.test.ts` and `test/goalBlockers.test.ts` own the SQL and
// the graph walk. What neither can reach is the wiring in between: a verb registered in three registries and
// granted to a role, a panel gated on `access.can`, and a payload whose ids arrive wire-tokenised. Every one
// of those fails silently - the server answers 403, the affordance hides itself, and the feature is simply
// not there.

// ---------------------------------------------------------------------------------------------------------

test("the evidence pack names what the record holds about the cycle", async ({ as }) => {
  test.setTimeout(180_000);
  const hr = await as("hr");
  const colleague = await as("manager"); // somebody other than the reviewee, to write the kudos
  // A dev Worker restart mid-request on a busy lane, documented across this suite. It is not what this test
  // reads.
  allowConsoleErrors(hr, /status of 503|status of 500/i);

  const stamp = Date.now() % 1_000_000;
  const cycleName = `E2E evidence cycle ${stamp}`;
  const praise = `E2E carried the migration ${stamp}`;
  const made: string[] = [];

  const employee = await personPath(hr, "employee");
  const employeeId = await personId(hr, "employee");

  // The kudos first, so it is inside the cycle's window by construction: the cycle below is dated from today.
  const kudos = await colleague.request.post("/v1/announcements:giveKudos", {
    headers: SPA_HEADERS,
    data: { recipient: `employees/${employeeId}`, message: praise },
  });
  expect(kudos.status(), await kudos.text()).toBe(200);
  made.push(((await kudos.json()) as { path: string }).path);

  const created = await hr.request.post("/v1/review-cycles", {
    headers: SPA_HEADERS,
    // A window that contains today, because the pack is bounded by it - a cycle dated last year would
    // correctly show nothing, and this spec would then be asserting that the panel is empty.
    data: { name: cycleName, period_start: daysAgo(30), period_end: daysAhead(30) },
  });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  made.push(cycle.path);

  const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [employee] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  try {
    await gotoRoute(hr, "reviews", "Reviews");
    const card = hr.locator('[id^="review-"]').filter({ hasText: cycleName }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expand(card);

    // ASKED FOR, NOT FETCHED ON OPEN - which is half of what this asserts. A review is opened to read a
    // rating far more often than to write one, so four queries on every open would be paid by people who are
    // not writing anything.
    const ask = card.getByRole("button", { name: /did this cycle/ });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await ask.click();

    // The kudos, quoted. A count would read as a score; the sentence somebody wrote is what a review carries.
    await expect(card.getByText("From the record")).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(praise)).toBeVisible({ timeout: 30_000 });
    // And the window it was gathered over, stated - the same four lists over a different period are a
    // different set of facts.
    await expect(card.getByText(/Nothing here is an assessment/)).toBeVisible();
  } finally {
    for (const path of made.reverse()) await purge(hr, path);
  }
});

// ---------------------------------------------------------------------------------------------------------

test("team goals name the goal that is holding the others up", async ({ as }) => {
  test.setTimeout(180_000);
  const manager = await as("manager");
  const admin = await as("super"); // the hard purge is an admin's to make
  allowConsoleErrors(manager, /status of 503|status of 500/i);

  const stamp = Date.now() % 1_000_000;
  const blockerTitle = `E2E blocker goal ${stamp}`;
  const madePaths: string[] = [];

  // The reports' goals, so the manager reads them under the TEAM scope this panel belongs to.
  const employeeId = await personId(manager, "employee");
  const owner = `employees/${employeeId}`;

  const blocker = await makeGoal(manager, { title: blockerTitle, employee: owner });
  madePaths.push(blocker);
  // TWO dependents, because one goal waiting on another is an ordinary dependency and needs no panel. The
  // panel appears at two, which is the threshold the component states.
  for (const n of [1, 2]) {
    madePaths.push(await makeGoal(manager, { title: `E2E waiting goal ${n} ${stamp}`, employee: owner, blocked_by: blocker }));
  }

  try {
    // `?view=flat` because the panel belongs to the flat list, and the view is remembered per browser: a
    // profile that last looked at the tree would land there and this would read as the panel missing.
    await gotoRoute(manager, "team-goals?view=flat", "Team goals");
    // The panel is computed from the rows already on screen, so it cannot appear before they are.
    await expect(manager.getByText(blockerTitle).first()).toBeVisible({ timeout: 30_000 });

    // Held by the COUNT LINE rather than by the section, because the page nests sections: a `section` filter
    // on the heading matches the panel and every ancestor of it, and the triage rows below carry the same
    // goal titles - so "the title is somewhere in here" was true before this panel existed.
    await expect(manager.getByText(/holding up 2 goals/)).toBeVisible({ timeout: 30_000 });
    const row = manager.locator("div").filter({ hasText: /holding up 2 goals/ }).last();
    // Named, with the count: "2 goals" is a number somebody has to go and look up, and the reason to act is
    // which goal it is.
    await expect(row).toContainText(blockerTitle);
  } finally {
    for (const path of madePaths.reverse()) await purge(admin, path);
  }
});

// ---------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (n: number) => ymdOf(Date.now() - n * DAY);
const daysAhead = (n: number) => ymdOf(Date.now() + n * DAY);

async function makeGoal(
  page: import("@playwright/test").Page,
  data: { title: string; employee?: string; blocked_by?: string },
): Promise<string> {
  const res = await page.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { ...data, description: "Raised by the work-record panels spec." },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** Open a review card, which is collapsed on arrival. Retried: the list re-renders as its lazy reads land,
 *  and a click that arrives mid-render toggles a card that is about to be replaced. */
async function expand(card: import("@playwright/test").Locator) {
  await expect(async () => {
    const header = card.getByRole("button").first();
    await expect(header).toBeVisible();
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 30_000 });
}
