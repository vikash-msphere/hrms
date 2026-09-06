import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// Being asked for feedback, and saying you are not the right person.
//
// A 360 request is a claim on somebody's time made by somebody else, so the answer "no" has to be a first
// class one: the person asked can decline, the request leaves their queue, and - this is the part that
// matters to the manager writing the review - the nomination stops reading as an outstanding "Pending" they
// are still waiting on. A decline that looked identical to silence would leave a review waiting forever on
// somebody who has already answered it.
//
// `feedback360` covers the nomination and the answer. `test/reviewFlow.test.ts` owns the records. What only a
// browser shows is the refusal: offered beside Submit, taking the card off the queue, and read back on the
// asker's card.
test("a nominated colleague declines, and the nomination stops reading as pending", async ({ as }) => {
  test.setTimeout(240_000);
  const hr = await as("hr");
  // The colleague being asked is the MANAGER, not super: `feedback360` nominates super for a review of the
  // same reviewee, and a request card names only the person the feedback is about - two specs asking the same
  // peer about the same colleague would be answering each other's request. Payroll cannot be asked at all:
  // the seeded policy gives them no Reviews page to answer it on.
  const peer = await as("manager");
  const admin = await as("super");
  const name = `E2E decline ${Date.now() % 1_000_000}`;

  await purgeLeftovers(admin);
  // A cycle with one reviewee, and a nomination on its review - both over the wire, since the launch dialog
  // and the picker are `reviews`' and `feedback360`'s subjects.
  const created = await hr.request.post("/v1/review-cycles", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [await personPath(hr, "employee")] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  const review = await reviewOf(hr, cycle.path);
  expect(review, "the launch produced no review").toBeTruthy();
  // Nominated by the MANAGER, which is who may: HR administers cycles but holds no `nominate` (only
  // `reviews.my-dept.nominate`, the reviewee's own manager, and an admin). Same division `feedback360` walks.
  const manager = await as("manager");
  const nominated = await manager.request.post(`/v1/${review}:nominate`, {
    headers: SPA_HEADERS,
    data: { employees: [await personPath(hr, "manager")] },
  });
  expect(nominated.status(), await nominated.text()).toBe(200);

  try {
    const reviewee = await personName(hr, "employee");
    await gotoRoute(peer, "reviews", "Reviews");
    const request = peer.locator("div.shadow-card, [class*=card]").filter({ hasText: `Share feedback on ${reviewee}` }).first();
    await expect(request).toBeVisible({ timeout: 30_000 });

    // The refusal sits beside the answer, quieter but present - a queue with no way out is a queue people
    // leave unanswered instead.
    await expect(request.getByRole("button", { name: "Submit feedback" })).toBeVisible();
    await request.getByRole("button", { name: "Decline", exact: true }).click();

    // Off their queue, and recorded as declined rather than as never answered.
    await expect(peer.getByText(`Share feedback on ${reviewee}`)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => feedbackStatus(hr, review!), { timeout: 30_000 }).toMatch(/declin/i);
  } finally {
    await purge(admin, cycle.path);
  }
});

/** The review this cycle's launch produced. */
async function reviewOf(page: import("@playwright/test").Page, cyclePath: string): Promise<string | undefined> {
  const res = await page.request.get("/v1/reviews?page_size=200");
  if (!res.ok()) return undefined;
  const { results = [] } = (await res.json()) as { results?: { path: string; cycle?: string }[] };
  return results.find((r) => r.cycle === cyclePath)?.path;
}

/** The state of the feedback requests raised on this review - `review-feedback` is its own collection. */
async function feedbackStatus(page: import("@playwright/test").Page, review: string): Promise<string> {
  const res = await page.request.get("/v1/review-feedback?page_size=200");
  if (!res.ok()) return "";
  const { results = [] } = (await res.json()) as { results?: { review?: string; state?: string }[] };
  return results.filter((f) => f.review === review).map((f) => f.state ?? "").join(",");
}

/** The seeded name behind a role login. */
async function personName(page: import("@playwright/test").Page, role: "employee" | "manager"): Promise<string> {
  const path = await personPath(page, role);
  const res = await page.request.get(`/v1/${path}`);
  expect(res.status(), await res.text()).toBe(200);
  const person = (await res.json()) as { first_name?: string; last_name?: string };
  return `${person.first_name} ${person.last_name}`;
}

/** Cycles this spec left behind on an earlier run. */
async function purgeLeftovers(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/review-cycles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => (x.name ?? "").startsWith("E2E decline "))) await purge(page, c.path);
}
