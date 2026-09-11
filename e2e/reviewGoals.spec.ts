import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";

// The goals a review is actually about.
//
// A review's competency ratings say how someone worked; the goals say what they delivered, and the link
// between the two is a real one now (`goals.cycle_id`) rather than a date guess. Launching a cycle claims the
// reviewee's in-window goals, the review carries them with a weighted attainment computed server-side, the
// employee can true a goal up during their self stage, the manager rates each goal beside the competencies,
// and sharing freezes the list so the record stops moving.
//
// `test/reviewGoals.test.ts` owns the arithmetic, the claim predicate and the snapshot. None of that is
// visible from the API alone: the panel, the self-stage slider, the per-goal scale in the manager form and
// the "as shared" frozen marker exist only in the rendered page.
test("a cycle claims a goal, the review scores it, and the manager rates it goal by goal", async ({ as }) => {
  test.setTimeout(300_000);
  const hr = await as("hr");
  const employee = await as("employee");
  const manager = await as("manager");
  const admin = await as("super"); // the hard purge of a cycle (and its reviews) is an admin's to make
  const name = `E2E review goals ${Date.now()}`;
  const goalTitle = `E2E scored goal ${Date.now() % 1_000_000}`;

  // A cycle left behind by a dead run still holds reviews for this person, and its card would answer with
  // somebody else's numbers.
  await purgeLeftovers(admin);

  // A window around today, so the goal's due date lands inside it whenever in the year this runs.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const employeePath = await personPath(hr, "employee");

  const createdCycle = await hr.request.post("/v1/review-cycles", {
    headers: SPA_HEADERS,
    data: { name, period_start: day(-30), period_end: day(30) },
  });
  expect(createdCycle.status(), await createdCycle.text()).toBe(200);
  const cycle = (await createdCycle.json()) as { path: string; etag: string };

  // The goal exists BEFORE the launch and names no cycle: the launch is what attaches it, which is the whole
  // point of claiming rather than guessing. Set by the MANAGER, because that is who sets a report's goals -
  // HR administers cycles and reads goals without editing them (`goals.**: read` in the seeded policy).
  const createdGoal = await manager.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { title: goalTitle, employee: employeePath, due_date: day(7), weight: 100, progress: 40 },
  });
  expect(createdGoal.status(), await createdGoal.text()).toBe(200);
  const goalPath = ((await createdGoal.json()) as { path: string }).path;

  try {
    const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
      headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
      data: { employees: [employeePath] },
    });
    expect(launched.status(), await launched.text()).toBe(200);
    // Claimed by the launch, without anybody restating it.
    await expect.poll(async () => (await goalOf(hr, goalPath))?.cycle, { timeout: 30_000 }).toBe(cycle.path);

    // ---- The employee's self stage: the goals they are about to be measured on, and a way to true them up.
    await gotoRoute(employee, "reviews", "Reviews");
    const mine = reviewCard(employee, name);
    await expect(async () => {
      await employee.reload();
      await expect(mine).toBeVisible({ timeout: 10_000 });
      await expand(mine);
      // 100 weight at 40% is 40% attained - the number the server computed from the goals it shipped.
      await expect(mine.getByText("Goals this cycle")).toBeVisible({ timeout: 10_000 });
      await expect(mine.getByText(/40%\s*attained/)).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });

    // The slider is offered because the goal is open, unmeasured and theirs; saving writes through the
    // updateProgress verb, so the review's score follows without leaving the page.
    await expect(async () => {
      await expand(mine);
      await mine.getByRole("slider", { name: new RegExp(`Progress on ${goalTitle}`) }).fill("80", { timeout: 8_000 });
      await mine.getByRole("button", { name: "Save", exact: true }).click({ timeout: 8_000 });
    }).toPass({ timeout: 60_000 });
    await expect(toast(employee, "Progress set to 80%")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await goalOf(hr, goalPath))?.progress, { timeout: 30_000 }).toBe(80);

    await expect(async () => {
      await expand(mine);
      await mine.getByPlaceholder(/Summarise your impact/).fill("Most of the way there.", { timeout: 8_000 });
      await mine.getByRole("button", { name: /^Submit self-assessment/ }).click({ timeout: 8_000 });
    }).toPass({ timeout: 60_000 });
    await expect(toast(employee, "Self-assessment submitted")).toBeVisible({ timeout: 30_000 });

    // ---- The manager's stage: the goal is rated on its own, next to what it is worth and where it got to.
    await gotoRoute(manager, "reviews", "Reviews");
    const theirs = reviewCard(manager, name);
    await expect(theirs).toBeVisible({ timeout: 30_000 });
    await expand(theirs);
    await expect(theirs.getByText("Manager review")).toBeVisible({ timeout: 30_000 });
    // The goal's whole row: its title and scale sit in one flex line and the note box is that line's SIBLING,
    // so `hasText` alone lands on the inner line - which holds the scale but not the note. Anchored on the
    // note box as well, `.last()` is the innermost div carrying both, the way the other card specs anchor.
    const goalRow = theirs
      .locator("div")
      .filter({ hasText: goalTitle })
      // Page-rooted on purpose: a `has:` locator is re-rooted at each candidate, and one built off another
      // locator's chain (`theirs.…`) matches nothing at all.
      .filter({ has: manager.getByPlaceholder(new RegExp(`Note on .${goalTitle}`)) })
      .last();
    await expect(goalRow.getByText(/wt 100 · 80%/)).toBeVisible({ timeout: 30_000 });

    // Sharing with the goal unrated names it in the same breath as a missing competency: an unscored goal is
    // the most conspicuous hole a review with a goals panel can have.
    await theirs.getByPlaceholder(/Overall feedback for the employee/).fill("Solid delivery.");
    const share = theirs.getByRole("button", { name: /^Share with employee/ });
    await share.click();
    const incomplete = manager.getByRole("dialog").filter({ hasText: "Share an incomplete review?" });
    await expect(incomplete).toBeVisible({ timeout: 30_000 });
    await expect(incomplete.getByText(/1 of 1 goal ratings/)).toBeVisible();
    await incomplete.getByRole("button", { name: "Cancel" }).click();
    await expect(manager.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // Every "3" on the form - the competencies, the overall, and the goal's own scale, which is why the goal
    // is given its own mark AFTER this sweep rather than before it.
    const scales = theirs.getByRole("button", { name: "3", exact: true });
    const count = await scales.count();
    for (let i = 0; i < count; i++) await scales.nth(i).click();
    await goalRow.getByRole("button", { name: "4", exact: true }).first().click();
    await goalRow.getByPlaceholder(new RegExp(`Note on .${goalTitle}`)).fill("Close, and the hard half is done.");
    await share.click();
    await expect(toast(manager, "Review shared with the employee")).toBeVisible({ timeout: 30_000 });

    // ---- Shared: the employee reads the verdict, and the list is now the frozen record.
    const shared = reviewCard(employee, name);
    await expect(async () => {
      await employee.reload();
      await expect(shared).toBeVisible({ timeout: 10_000 });
      await expand(shared);
      await expect(shared.getByText("as shared")).toBeVisible({ timeout: 10_000 });
      await expect(shared.getByText("Close, and the hard half is done.").first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });

    // The goal moves again - by its OWNER, who holds `goals.me.updateProgress`; the shared review keeps
    // saying what it said the day it was shared.
    const moved = await employee.request.post(`/v1/${goalPath}:updateProgress`, { headers: SPA_HEADERS, data: { progress: 100, status: "completed" } });
    expect(moved.status(), await moved.text()).toBe(200);
    await expect(async () => {
      await employee.reload();
      await expect(shared).toBeVisible({ timeout: 10_000 });
      await expand(shared);
      await expect(shared.getByText(/80%\s*attained/)).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });

    // ---- HR's cycle card: rating against delivery, which a distribution bar cannot say on its own.
    await gotoRoute(hr, "settings/performance");
    await hr.getByRole("tab", { name: "Review cycles" }).click();
    // The cycle's own card: the innermost box holding both this cycle's name and the button (the same
    // anchoring calibration.spec.ts needs, for the same reason - a hasText filter matches every ancestor).
    const card = hr
      .locator("div")
      .filter({ has: hr.getByText(name, { exact: true }) })
      .filter({ has: hr.getByRole("button", { name: "Calibration" }) })
      .last();
    await expect(card.getByRole("button", { name: "Calibration" })).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: "Calibration" }).click();
    const panel = hr.locator('div:has(> div > p:text-is("Calibration"))');
    await expect(panel.getByText("Rating against delivery")).toBeVisible({ timeout: 30_000 });
    // One review placed: rated 3, delivered 80% - the middle band, short of target.
    await expect(panel.getByText(/1 placed/)).toBeVisible({ timeout: 30_000 });

    // And the cycle's attainment curve, which is the app's only chart behind a press rather than on a page -
    // `everyChart` walks pages, so this is where that one is proved drawn AND readable (`figure` + the table
    // the picture is aria-hidden in favour of). It needs a cycle whose goals actually moved, which is this one.
    const figure = panel.locator("figure").filter({ has: hr.locator("figcaption") }).first();
    await expect(figure.locator("svg").first()).toBeAttached({ timeout: 30_000 });
    const box = await figure.locator("svg").first().boundingBox();
    expect(box?.width ?? 0, "the attainment chart drew no picture").toBeGreaterThan(0);
    await expect(figure.locator("table tbody tr").first()).toBeAttached();
  } finally {
    await purge(admin, cycle.path); // takes its reviews with it and cuts the goal's link
    await purge(admin, goalPath);
  }
});

/** Take out every cycle these specs have ever launched, and the reviews that came with it. */
async function purgeLeftovers(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/review-cycles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => (x.name ?? "").startsWith("E2E review goals"))) await purge(page, c.path);
}

/** One goal as the API has it - the cycle it was claimed by, and where its progress stands. */
async function goalOf(page: import("@playwright/test").Page, path: string) {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return (await res.json()) as { cycle?: string; progress?: number };
}

/** One review's card, by the id the page stamps on it. */
function reviewCard(page: import("@playwright/test").Page, cycleName: string) {
  return page.locator('[id^="review-"]').filter({ hasText: cycleName }).first();
}

/** Open the accordion: everything below a review card's header is out of the DOM while it is folded. */
async function expand(card: import("@playwright/test").Locator) {
  const header = card.getByRole("button").first();
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click({ timeout: 8_000 });
  await expect(header).toHaveAttribute("aria-expanded", "true", { timeout: 8_000 });
}
