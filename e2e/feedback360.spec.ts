import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";

// 360 peer feedback: the third person in a review.
//
// `reviewStages.spec.ts` walks the two-party machine (employee writes, manager shares, employee
// acknowledges). This is the branch that leaves it: the manager nominates colleagues, each nomination
// becomes a request addressed to somebody ELSE, and their answer comes back onto the review the manager is
// writing. Three browsers, three different renderings of the same row - a picker that will not offer the
// reviewee, a queue section that only shows requests addressed to the caller, and a feedback list that
// names the author and its state.
//
// None of it is reachable from the server suite: `test/reviewFlow.test.ts` owns whether a nomination is
// allowed and what `submitFeedback` writes. What only a browser shows is that the nomination is made from
// the review card at all (the picker is client-ranked and client-excluded), that the person asked finds the
// request on their own page without being told where to look, and that the answer lands back on the
// manager's card as "<author> · Submitted" rather than staying a row nobody sees.
//
// Roles are forced by the seeded policy, not by taste: only `manager` holds `reviews.my-dept.nominate`, and
// the peer has to hold `review-feedback.me.submitFeedback`, which among the five seeded logins means the
// employee (who is the reviewee here) or an admin. So the manager nominates super.
test("a nominated colleague is asked for 360 feedback, and their answer lands on the review", async ({ as }) => {
  test.setTimeout(300_000);
  const hr = await as("hr");
  const manager = await as("manager");
  // The peer AND the housekeeper: purging a cycle (and the reviews it owns) is not HR's to make.
  const peer = await as("super");
  const name = `E2E 360 ${Date.now()}`;
  const comment = "Unblocked our importer twice this quarter and wrote the runbook for it.";

  // A review cannot be deleted on its own - the cycle owns it - so a run that died half way leaves a live
  // review, and a second one for the same person would make "the card" ambiguous. Start clean.
  await purgeLeftovers(peer);

  // A cycle with one reviewee, minted over the wire: the launch dialog is `reviews.spec.ts`'s subject.
  const created = await hr.request.post("/v1/review-cycles", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [await personPath(hr, "employee")] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  const revieweeName = await personName(hr, "employee");
  const peerName = await personName(peer, "super");

  // The manager's own page carries the review, and the peer-feedback panel on it is empty and says so.
  await gotoRoute(manager, "reviews", "Reviews");
  const card = reviewCard(manager, name);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await openCard(card);
  await expect(card.getByText("No peer feedback requested yet.")).toBeVisible({ timeout: 30_000 });

  // The picker names who it is about, and will not offer the reviewee themselves - the one nomination that
  // is never meaningful, excluded in the browser rather than refused by the server afterwards.
  await card.getByRole("button", { name: "Request feedback" }).click();
  const picker = manager.getByRole("dialog");
  await expect(picker.getByRole("heading", { name: `Request 360 feedback on ${revieweeName}` })).toBeVisible({ timeout: 30_000 });
  await picker.getByPlaceholder("Search name…").fill(revieweeName);
  await expect(picker.getByRole("checkbox", { name: revieweeName })).toHaveCount(0);

  // Nothing is sent until somebody is picked, which is what stops an empty press creating a cycle of
  // silence nobody chased.
  const send = picker.getByRole("button", { name: "Send requests" });
  await expect(send).toBeDisabled();
  await picker.getByPlaceholder("Search name…").fill(peerName);
  await picker.getByRole("checkbox", { name: peerName }).click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(manager.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The nomination is on the card, as an outstanding one - the manager has to be able to see who has been
  // asked before anybody has answered, or they ask the same people twice.
  //
  // Retried around a reload rather than simply waited out: the peer-feedback panel is drawn from the
  // EMBEDDED copy on the review (see the `feedback` array in src/http/serialize.ts), and the reviews list is
  // cached for the page life - so the write's own re-read can be served the copy it was made against, and
  // the entry appears on the next real read rather than on this one. The claim being made here is that the
  // nomination reaches the card, not that it repaints within a particular tick.
  await expect(async () => {
    const entry = reviewCard(manager, name).locator("div").filter({ hasText: peerName }).last();
    if (!(await entry.count())) {
      await manager.reload();
      await expect(manager.getByRole("main")).toBeVisible();
      await openCard(reviewCard(manager, name));
    }
    await expect(entry).toContainText("Pending", { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });

  // The person asked finds it on their own Reviews page, in a section that is theirs: `review-feedback` is
  // readable org-wide to an admin, so a queue built from the collection rather than from authorship would
  // show them everybody's requests and ask them to answer requests that are not theirs.
  await gotoRoute(peer, "reviews", "Reviews");
  const request = peer.locator("div.shadow-card, [class*=card]").filter({ hasText: `Share feedback on ${revieweeName}` }).first();
  await expect(request).toBeVisible({ timeout: 30_000 });

  // Nothing to submit while it is empty: an all-blank "response" would close the request and tell the
  // manager it had been answered.
  const submit = request.getByRole("button", { name: "Submit feedback" });
  await expect(submit).toBeDisabled();
  await request.getByPlaceholder(/What does this person do well/).fill(comment);
  await expect(submit).toBeEnabled();
  await request.getByRole("button", { name: "4", exact: true }).first().click();
  await submit.click();
  await expect(toast(peer, "Feedback submitted")).toBeVisible({ timeout: 30_000 });

  // Answered, it leaves the queue rather than sitting there inviting a second answer.
  await expect(peer.getByText(`Share feedback on ${revieweeName}`)).toHaveCount(0, { timeout: 30_000 });

  // And it arrives on the review the manager is writing: the author, the mark and the words. A reload
  // rather than a re-navigation - the manager's browser is already here, and a write in somebody else's
  // session cannot reach into this one's cached rows.
  await manager.reload();
  await expect(manager.getByRole("main")).toBeVisible();
  await openCard(reviewCard(manager, name));
  const answered = reviewCard(manager, name).locator("div").filter({ hasText: peerName }).last();
  await expect(answered).toContainText("Submitted", { timeout: 30_000 });
  await expect(reviewCard(manager, name).getByText(comment)).toBeVisible();

  // A live cycle nags everybody it touches, so it goes away with its reviews and their feedback.
  await purge(peer, cycle.path);
});

type Page = import("@playwright/test").Page;

/** Take out every cycle this spec has ever launched, and the reviews that came with it. */
async function purgeLeftovers(page: Page) {
  const res = await page.request.get("/v1/review-cycles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => (x.name ?? "").startsWith("E2E 360"))) await purge(page, c.path);
}

/** One review's card, by the id the page stamps on it. */
function reviewCard(page: Page, cycleName: string) {
  return page.locator('[id^="review-"]').filter({ hasText: cycleName }).first();
}

/**
 * Expand a review card, the way its reader would.
 *
 * The page only leaves cards open while there are few of them, or while they are waiting on the person
 * looking (web/src/pages/Reviews.tsx) - and this one is waiting on the employee's self-assessment. So on a
 * manager with a full page it comes up as a header, and every affordance under it is unrendered rather than
 * merely off screen. Idempotent, because it is also called after a reload, which puts every card back.
 */
async function openCard(card: import("@playwright/test").Locator) {
  // The press is inside the retry, not before it. A card read while the page is still settling reports
  // itself collapsed and then re-renders, swallowing the one click - and a spec that clicked once and then
  // only waited would sit there watching a header that nothing is ever going to open.
  await expect(async () => {
    const header = card.getByRole("button").first();
    await expect(header).toBeVisible();
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 60_000 });
}

/**
 * How a seeded person is WRITTEN on screen.
 *
 * The picker, the queue and the feedback list all render `first_name last_name`, and a spec that hard-coded
 * one of them would be a rename away from silently matching nothing - `toHaveCount(0)` on the reviewee is
 * exactly the assertion a wrong name passes for the wrong reason.
 */
async function personName(page: Page, role: "super" | "hr" | "manager" | "payroll" | "employee"): Promise<string> {
  const path = await personPath(page, role);
  const res = await page.request.get(`/v1/${path}`);
  expect(res.status(), await res.text()).toBe(200);
  const person = (await res.json()) as { first_name?: string; last_name?: string };
  return `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim();
}
