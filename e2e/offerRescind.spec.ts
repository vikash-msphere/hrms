import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The company changing its mind.
//
// An extended offer has three endings, and `offerOutcome` drives two of them. The third is the one nobody
// enjoys: rescinding, after the candidate has already been told. It is the most consequential press in the
// hiring flow - it reaches a person outside the company - so it is also the one where the browser owes the
// most: the question has to name what it does to the candidate, backing out has to leave the offer standing,
// and afterwards the row must stop offering the endings that no longer apply.
//
// `offers` walks draft → approved → extended; `test/ats.test.ts` owns the state machine. What only a browser
// shows is the question and what the row does with the answer.
test("an extended offer is rescinded, after the question says what that means", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("hr");
  const admin = await as("super"); // the hard purge is an admin's to make
  const stamp = Date.now() % 1_000_000;
  const candidate = `E2E Rescinds ${stamp}`;

  const made = await extendedOffer(page, candidate, stamp);

  try {
    await gotoRoute(page, "offers", "Offers");
    const row = page.locator("tbody tr").filter({ hasText: candidate });
    await expect(row).toHaveCount(1, { timeout: 30_000 });

    // Backing out first: this is the press somebody makes with their finger already moving, and it must be
    // recoverable right up to the last moment.
    await row.getByRole("button", { name: "Rescind", exact: true }).click();
    const ask = page.getByRole("dialog").filter({ hasText: "Rescind this offer?" });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask.getByText("This withdraws the offer from the candidate.")).toBeVisible();
    await ask.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    expect(await status(page, made.offer), "backing out rescinded the offer anyway").toBe("extended");

    // And through with it.
    await row.getByRole("button", { name: "Rescind", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Rescind", exact: true }).click();
    await expect.poll(() => status(page, made.offer), { timeout: 30_000 }).toBe("rescinded");

    // The row now says what happened and offers none of the endings that have gone: a rescinded offer cannot
    // be accepted by anybody.
    await expect(row).toContainText(/Rescinded/i, { timeout: 30_000 });
    await expect(row.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Decline", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Rescind", exact: true })).toHaveCount(0);
  } finally {
    await purge(admin, made.offer);
    await purge(admin, made.application);
    await purge(admin, made.candidatePath);
    await purge(admin, made.requisition);
  }
});

type Made = { candidate: string; candidatePath: string; requisition: string; application: string; offer: string };

/** An offer already in the candidate's hands - everything up to that point is `offers`' subject. */
async function extendedOffer(page: import("@playwright/test").Page, candidate: string, seed: number): Promise<Made> {
  const requisition = await create(page, "job-requisitions", { title: `E2E rescind role ${seed}`, openings: 1 });
  const candidatePath = await create(page, "candidates", { name: candidate, email: `e2e.rescind.${seed}@example.com` });
  const application = await create(page, "applications", { candidate: candidatePath, requisition, stage: "offer" });
  const offer = await create(page, "offers", { application, base_comp: 1_800_000 });
  for (const verb of ["approve", "extend"]) {
    const res = await page.request.post(`/v1/${offer}:${verb}`, { headers: SPA_HEADERS });
    expect(res.status(), `${verb}: ${await res.text()}`).toBeLessThan(300);
  }
  return { candidate, candidatePath, requisition, application, offer };
}

async function create(page: import("@playwright/test").Page, collection: string, data: Record<string, unknown>): Promise<string> {
  const res = await page.request.post(`/v1/${collection}`, { headers: SPA_HEADERS, data });
  expect(res.status(), `${collection}: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** The offer's status, as the server holds it - `status` on this collection, not `state`. */
async function status(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { status?: string }).status?.toLowerCase();
}
