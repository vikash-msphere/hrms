import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// The two things you can do about a review that is not moving.
//
// A review cycle stalls on whoever owes the next step, and HR gets exactly two moves: remind them, or take
// the stage out of the way. Both are drawn ONLY for a viewer the review is not waiting on - nudging yourself
// is noise, and skipping your own stage is how a self-assessment quietly stops being one - so which buttons
// exist is a per-card decision the browser makes, and it is the whole of this feature.
//
// `reviews` covers launching a cycle and `reviewStages` the self → manager → shared → acknowledged walk.
// `test/reviewFlow.test.ts` owns the machine. What only a browser shows is the pair of escape hatches on a
// stalled card: that they are offered to HR, that the nudge reaches the person, and that the skip moves the
// review on without anybody writing the stage that was skipped.
test("HR nudges a stalled review, then skips the stage it is stuck on", async ({ as }) => {
  test.setTimeout(240_000);
  const hr = await as("hr");
  const employee = await as("employee");
  const admin = await as("super"); // the hard purge is an admin's to make
  const name = `E2E nudge ${Date.now() % 1_000_000}`;

  // A cycle of this spec's own with one reviewee, minted over the wire - launching is `reviews`' subject.
  // Leftovers first: a review cannot be deleted on its own (the cycle owns it), so a run that died half way
  // leaves a card nagging the same person forever.
  await purgeLeftovers(admin);
  const created = await hr.request.post("/v1/review-cycles", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [await personPath(hr, "employee")] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  try {
    // It is waiting on the employee's self-assessment, so HR - who owes nothing - is the viewer both moves
    // are drawn for.
    await gotoRoute(hr, "reviews", "Reviews");
    const card = hr.locator('[id^="review-"]').filter({ hasText: name }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Both moves live in the card's BODY, beside the sentence saying who it is waiting on - so the card has
    // to be open. Collapsed, it is a header and a state chip and neither button exists.
    await openCard(card);

    // Counted before, because an earlier run of this spec left its own reminders in the same inbox.
    const before = await nudges(employee);
    await card.getByRole("button", { name: "Nudge", exact: true }).click();
    // The nudge is a message to a person, not a state change: it lands in the bell of whoever the review is
    // waiting on, which is the only place it can be observed at all. Matched by TYPE rather than by a count -
    // half the lane is notifying this same seeded person while this runs.
    await expect.poll(() => nudges(employee), { timeout: 30_000 }).toBeGreaterThan(before);

    // And the other move: the stage the review is stuck on is taken out of the way, and the review is now
    // somebody else's problem - without the skipped stage ever being written.
    await card.getByRole("button", { name: "Skip stage" }).click();
    const ask = hr.getByRole("dialog").filter({ hasText: "Skip this stage?" });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask.getByText("The review moves to the next stage without this stage's input.")).toBeVisible();
    await ask.getByRole("button", { name: "Skip stage", exact: true }).click();
    await expect.poll(() => reviewState(hr, name), { timeout: 30_000 }).not.toBe("SELF");
  } finally {
    await purge(admin, cycle.path);
  }
});

/** Review reminders sitting in this person's notifications. */
async function nudges(page: import("@playwright/test").Page): Promise<number> {
  const res = await page.request.get("/v1/notifications?page_size=100");
  if (!res.ok()) return 0;
  const { results = [] } = (await res.json()) as { results?: { type?: string }[] };
  return results.filter((n) => n.type === "review.nudge").length;
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
  return results.find((r) => r.cycle === cycle.path)?.state?.toUpperCase();
}

/** Cycles this spec left behind on an earlier run. */
async function purgeLeftovers(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/review-cycles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => (x.name ?? "").startsWith("E2E nudge "))) await purge(page, c.path);
}

/** Unfold a review card - its stage moves are drawn in the body, not on the collapsed header. */
async function openCard(card: import("@playwright/test").Locator) {
  const header = card.getByRole("button").first();
  await expect(header).toBeVisible({ timeout: 30_000 });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true", { timeout: 30_000 });
}
