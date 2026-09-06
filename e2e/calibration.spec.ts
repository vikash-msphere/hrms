import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// HR reading a whole cycle at once, instead of one review at a time.
//
// Calibration is the question "are we marking consistently?", and it is answered entirely in the browser:
// the panel opens on demand, follows the reviews cursor itself, and then counts, averages and buckets the
// shared ratings client-side against whatever rating scale the org has configured. Nothing about that
// distribution exists on the server - there is no endpoint that returns it - so a panel that summed the
// wrong rows, counted unshared reviews as rated, or ignored the department filter would look perfectly
// healthy to `npm test`.
//
// The narrowing is asserted as well as the totals, because the department filter is the whole point of the
// screen: "we rate generously" is a conversation about one team, and a filter that reads the label but not
// the rows would answer it with the company's numbers.
//
// The cycle is minted and rated over the wire. `reviewStages.spec.ts` owns how a rating is actually
// entered; what this spec needs is two known marks on two known people, so the arithmetic on screen has a
// right answer.
test("the calibration panel counts a cycle's shared ratings, and narrows to one department", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const name = `E2E calibration ${Date.now()}`;

  // A cycle left behind by a dead run still counts reviews, and its panel would answer with somebody
  // else's numbers.
  await purgeLeftovers(page);

  // Two people in two different departments, so "all" and "one team" have different right answers. Read off
  // the seeded org rather than named: a spec that hard-codes people is one seed edit from testing nothing.
  const { a, b } = await twoDepartments(page);

  const created = await page.request.post("/v1/review-cycles", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  const launched = await page.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [a.path, b.path] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  // A rating is only counted once it is SHARED, so each review is walked to that point: past the
  // self-assessment stage, then the manager's mark. Two marks either side of the middle, so the average is
  // a number neither of them is - a panel reading one row and calling it the average cannot pass.
  const reviews = await reviewsOf(page, cycle.path);
  expect(reviews).toHaveLength(2);
  const marks = new Map<string, number>();
  for (const review of reviews) {
    const mark = review.employee && idOf(review.employee) === idOf(a.path) ? 4 : 2;
    marks.set(review.path, mark);
    // No body: `skipStage` declares none, and the contract proxy in front of the Worker rejects a request
    // that sends one.
    const skipped = await page.request.post(`/v1/${review.path}:skipStage`, { headers: SPA_HEADERS });
    expect(skipped.status(), await skipped.text()).toBe(200);
    const shared = await page.request.post(`/v1/${review.path}:submitManager`, {
      headers: SPA_HEADERS,
      data: { overall_rating: mark, manager_comment: "Calibrated over the wire." },
    });
    expect(shared.status(), await shared.text()).toBe(200);
  }

  // The panel is lazy - the cycle list never reads reviews until somebody asks this question.
  await gotoRoute(page, "settings/performance");
  await page.getByRole("tab", { name: "Review cycles" }).click();
  // The cycle's own card: the innermost box holding BOTH this cycle's name and the button. A `hasText`
  // filter alone matches every ancestor as well as the card, and its innermost match is the little box
  // around the name, which has no buttons in it at all.
  const card = page
    .locator("div")
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Calibration" }) })
    .last();
  await expect(card.getByRole("button", { name: "Calibration" })).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Calibration" }).click();

  // Both reviews, both rated, neither acknowledged, and the average of 4 and 2 - with the scale's own word
  // for it, because a bare 3.0 means nothing without the org's ladder beside it.
  const panel = calibrationPanel(page);
  await expect(panel.getByText("2 rated")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("0 acknowledged")).toBeVisible();
  await expect(panel.getByText(/^3\.0 average/)).toBeVisible();

  // One department: one review, one rating, and the average is that person's mark rather than the org's.
  await panel.getByRole("combobox").click();
  await page.getByRole("option", { name: a.department_name, exact: true }).click();
  await expect(panel.getByText("1 rated")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/^4\.0 average/)).toBeVisible();

  // A live cycle nags everybody it touches, so it goes away with its reviews.
  await purge(page, cycle.path);
});

type Page = import("@playwright/test").Page;

/** The wire id half of a resource path, the way the app's own `idOf` reads it. */
function idOf(path: string): string {
  return path.split("/").pop() ?? "";
}

/**
 * The panel itself, not the page around it.
 *
 * Anchored on the one div whose own child row holds the "Calibration" heading: a `hasText` filter matches
 * every ancestor as well, and an assertion that lands on the page body reads the cycle card's "2 reviews"
 * instead of the panel's - which is the exact number this spec is checking.
 */
function calibrationPanel(page: Page) {
  return page.locator('div:has(> div > p:text-is("Calibration"))');
}

/** Take out every cycle this spec has ever launched, and the reviews that came with it. */
async function purgeLeftovers(page: Page) {
  const res = await page.request.get("/v1/review-cycles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => (x.name ?? "").startsWith("E2E calibration"))) await purge(page, c.path);
}

/** The reviews one cycle launched. */
async function reviewsOf(page: Page, cycle: string): Promise<{ path: string; employee?: string }[]> {
  const res = await page.request.get(`/v1/reviews?cycle=${encodeURIComponent(cycle)}&page_size=100`);
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; employee?: string }[] };
  return results;
}

/** One active person from each of two different departments, with the department named as the filter names it. */
type Picked = { path: string; department_name: string };
async function twoDepartments(page: Page): Promise<{ a: Picked; b: Picked }> {
  const [people, depts] = await Promise.all([
    page.request.get("/v1/employees?page_size=200"),
    page.request.get("/v1/departments?page_size=100"),
  ]);
  expect(people.status(), await people.text()).toBe(200);
  expect(depts.status(), await depts.text()).toBe(200);
  const { results: employees = [] } = (await people.json()) as { results?: { path: string; department?: string; status?: string }[] };
  const { results: departments = [] } = (await depts.json()) as { results?: { path: string; display_name?: string }[] };
  const named = new Map(departments.map((d) => [idOf(d.path), d.display_name ?? ""]));

  const picked: Picked[] = [];
  const seen = new Set<string>();
  for (const e of employees) {
    if (!e.department || (e.status && e.status !== "active")) continue;
    const dept = idOf(e.department);
    const label = named.get(dept);
    if (seen.has(dept) || !label) continue;
    seen.add(dept);
    picked.push({ path: e.path, department_name: label });
    if (picked[0] && picked[1]) return { a: picked[0], b: picked[1] };
  }
  throw new Error("e2e: the seeded org has fewer than two departments with people in them");
}
