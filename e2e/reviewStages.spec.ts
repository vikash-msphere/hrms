import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";

// A review, written by the two people it is about.
//
// `reviews.spec.ts` launches a cycle and stops there - deliberately, because launching is the irreversible
// press. This is what happens afterwards, and it is three browsers' worth of state machine: the employee
// writes their self-assessment, the manager writes theirs (seeing the employee's self ratings beside their
// own scale, which is the reason the two are in one form), sharing hands the result to the employee, and the
// employee acknowledges it. Each stage shows a different form to a different person and hides the other's
// answer until it is due - none of which exists outside the rendered page.
//
// `test/reviewFlow.test.ts` owns the state machine's rules. The cycle is launched over the wire here so the
// spec is about the stages rather than about the launch dialog.
test("an employee writes their self-assessment, their manager shares a rating, and they acknowledge it", async ({ as }) => {
  test.setTimeout(300_000);
  const hr = await as("hr");
  const employee = await as("employee");
  const manager = await as("manager");
  // The housekeeping is super's: a hard purge of a cycle (and the reviews it owns) is not HR's to make.
  const admin = await as("super");
  const name = `E2E stages ${Date.now()}`;
  const selfText = "Shipped the importer and want to grow into design reviews.";
  const managerText = "Strong year - owned the importer end to end.";

  // Reviews cannot be deleted on their own (the cycle owns them), so a run that died half way leaves a live
  // review nagging everybody it touches - and two cards claiming to need the same person. Start clean.
  await purgeLeftovers(admin);

  // A cycle with one reviewee, minted over the wire.
  const created = await hr.request.post("/v1/review-cycles", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [await personPath(hr, "employee")] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  // The employee's own page carries the review, open at the stage that is theirs: the self-assessment, which
  // will not submit until something has actually been written.
  await gotoRoute(employee, "reviews", "Reviews");
  // The card by its own id prefix (`#review-<id>`), which is the element that holds the whole review - a
  // `div.shadow-card` filter lands on an inner box and drops the buttons at the bottom of it.
  const mine = reviewCard(employee, name);
  await expect(mine).toBeVisible({ timeout: 30_000 });
  const submitSelf = mine.getByRole("button", { name: /^Submit self-assessment/ });
  await expect(submitSelf).toBeDisabled();

  await mine.getByPlaceholder(/Summarise your impact/).fill(selfText);
  // The optional self ratings, on the same scale the manager uses - the gap between the two is the
  // conversation the form exists to start.
  const selfScale = mine.locator("div").filter({ hasText: "Rate yourself" }).last();
  await selfScale.getByRole("button", { name: "4", exact: true }).first().click();
  await expect(submitSelf).toBeEnabled();
  await submitSelf.click();
  await expect(toast(employee, "Self-assessment submitted")).toBeVisible({ timeout: 30_000 });

  // Nothing of the manager's is shown to them yet - a rating that leaked before it was shared would be the
  // one thing this machine must not do.
  await expect(mine.getByRole("button", { name: /^Share with employee/ })).toHaveCount(0);

  // The manager's turn: their form carries the employee's self rating beside the scale, and it will not
  // submit while it is empty.
  await gotoRoute(manager, "reviews", "Reviews");
  const theirs = reviewCard(manager, name);
  await expect(theirs).toBeVisible({ timeout: 30_000 });
  // Everything scoped to THIS review's card: the page carries every review the caller is on the hook for,
  // and an assertion loose on the page would read another cycle's form.
  await expect(theirs.getByText("Manager review")).toBeVisible({ timeout: 30_000 });
  await expect(theirs.getByText(/self: 4/).first()).toBeVisible();
  const share = theirs.getByRole("button", { name: /^Share with employee/ });
  await expect(share).toBeDisabled();

  // An overall mark and the words, with the per-competency scale left blank: sharing is the moment the
  // employee reads it and the review cannot come back, so an incomplete one is questioned rather than sent.
  const scales = theirs.getByRole("button", { name: "4", exact: true });
  await scales.last().click(); // the Overall row is the last scale on the form
  await theirs.getByPlaceholder(/Overall feedback for the employee/).fill(managerText);
  await expect(share).toBeEnabled();
  await share.click();
  const incomplete = manager.getByRole("dialog").filter({ hasText: "Share an incomplete review?" });
  await expect(incomplete).toBeVisible({ timeout: 30_000 });
  await expect(incomplete.getByText(/Missing: \d+ of \d+ competency ratings/)).toBeVisible();
  await incomplete.getByRole("button", { name: "Cancel" }).click();
  await expect(manager.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // Rated in full, it goes without a question.
  const count = await scales.count();
  for (let i = 0; i < count; i++) await scales.nth(i).click();
  await share.click();
  await expect(toast(manager, "Review shared with the employee")).toBeVisible({ timeout: 30_000 });

  // Shared: now - and only now - the employee reads the rating and the words, and the one thing left to do
  // is say they have seen it.
  // A reload, not a re-navigation: the employee's browser is already on this route, and a write in somebody
  // else's session cannot reach into this one's cached rows.
  await employee.reload();
  await expect(employee.getByRole("main")).toBeVisible();
  const shared = reviewCard(employee, name);
  await expect(shared.getByText(managerText)).toBeVisible({ timeout: 30_000 });
  // Exact: the card's own accordion header is a button too, and its accessible name carries the stage rail -
  // "Self Manager Shared Acknowledged" - so a substring match on "Acknowledge" clicks the header and folds
  // the card instead of acknowledging anything.
  const acknowledge = shared.getByRole("button", { name: "Acknowledge", exact: true });
  await expect(acknowledge).toBeVisible({ timeout: 30_000 });
  await acknowledge.click();

  // Acknowledged is the end of the machine, and the card says so instead of still asking. (The outcome, not
  // the toast: acknowledging re-reads the whole page, and the announcement is gone by the time it settles.)
  await expect(reviewCard(employee, name).getByRole("button", { name: "Acknowledge", exact: true })).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => reviewState(hr, name), { timeout: 30_000 }).toBe("ACKNOWLEDGED");

  // A live cycle nags everybody it touches, so it goes away with its reviews.
  await purge(admin, cycle.path);
});

/** Take out every cycle these specs have ever launched, and the reviews that came with it. */
async function purgeLeftovers(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/review-cycles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => (x.name ?? "").startsWith("E2E stages"))) await purge(page, c.path);
}

/** One review's card, by the id the page stamps on it. */
function reviewCard(page: import("@playwright/test").Page, cycleName: string) {
  return page.locator('[id^="review-"]').filter({ hasText: cycleName }).first();
}

/** The state of the review this spec's cycle minted. */
async function reviewState(page: import("@playwright/test").Page, cycleName: string): Promise<string | undefined> {
  const cycles = await page.request.get("/v1/review-cycles?page_size=100");
  if (!cycles.ok()) return undefined;
  const { results: cs = [] } = (await cycles.json()) as { results?: { path: string; name?: string }[] };
  const cycle = cs.find((c) => c.name === cycleName);
  if (!cycle) return undefined;
  const reviews = await page.request.get("/v1/reviews?page_size=200");
  if (!reviews.ok()) return undefined;
  const { results = [] } = (await reviews.json()) as { results?: { cycle?: string; state?: string }[] };
  return results.find((r) => r.cycle === cycle.path)?.state;
}
