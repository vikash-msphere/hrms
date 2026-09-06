import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// What happens after an offer goes out.
//
// `offers.spec.ts` walks draft → approved → extended and stops at the moment the candidate is told. Every
// path after that is a different ending and they are not interchangeable: ACCEPTED starts a hire, DECLINED
// closes the loop with a reason worth keeping, and RESCINDED is the company changing its mind, which is the
// one that has to be possible right up to the last moment. Each is a verb of its own, offered only in the
// state it belongs to. The offer LETTER is the other browser-only piece: a PDF generated from the offer and
// handed over as a file, which is what the candidate actually receives.
test("an extended offer is read as a letter, then accepted; another is declined", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("hr");
  const stamp = Date.now();

  const accepted = await extendedOffer(page, `E2E Accepts ${stamp}`, stamp);
  const declined = await extendedOffer(page, `E2E Declines ${stamp}`, stamp + 1);

  await gotoRoute(page, "offers", "Offers");

  // The letter: the offer as a document, rendered on demand rather than stored - the same path a candidate's
  // copy comes from.
  const acceptRow = page.locator("tbody tr").filter({ hasText: accepted.candidate });
  await expect(acceptRow).toHaveCount(1, { timeout: 30_000 });
  await acceptRow.getByRole("button", { name: "Offer letter" }).click();
  const letter = page.getByRole("dialog");
  await expect(letter).toBeVisible({ timeout: 60_000 });
  await expect(letter.locator("iframe, embed, object").first()).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // Accepted: the candidate said yes, and the row says so rather than still offering to extend.
  await acceptRow.getByRole("button", { name: "Accept", exact: true }).click();
  await confirmIfAsked(page, /Accept/);
  await expect(acceptRow).toContainText(/Accepted/i, { timeout: 30_000 });
  await expect(acceptRow.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);

  // Declined: the other ending, which closes the offer without hiring anybody.
  const declineRow = page.locator("tbody tr").filter({ hasText: declined.candidate });
  await declineRow.getByRole("button", { name: "Decline", exact: true }).click();
  // The confirm repeats the OUTCOME, not the button ("Mark declined"), because that is what it commits to.
  await confirmIfAsked(page, /Mark declined|Decline/);
  await expect(declineRow).toContainText(/Declined/i, { timeout: 30_000 });

  for (const made of [accepted, declined]) {
    await purge(page, made.offer);
    await purge(page, made.application);
    await purge(page, made.candidatePath);
    await purge(page, made.requisition);
  }
});

type Made = { candidate: string; candidatePath: string; requisition: string; application: string; offer: string };

/** An offer already in the candidate's hands - everything up to that point is `offers.spec.ts`'s subject. */
async function extendedOffer(page: import("@playwright/test").Page, candidate: string, seed: number): Promise<Made> {
  const requisition = await create(page, "job-requisitions", { title: `E2E role ${seed}`, openings: 1 });
  const candidatePath = await create(page, "candidates", { name: candidate, email: `e2e.offer.${seed}@example.com` });
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

/**
 * Answer the confirm, where the decision asks for one.
 *
 * WAITED for, not counted: the dialog is raised by the click that precedes this, so a count taken in the same
 * tick reads zero and the decision is left sitting behind an unanswered question.
 */
async function confirmIfAsked(page: import("@playwright/test").Page, label: RegExp) {
  const button = page.getByRole("dialog").getByRole("button", { name: label }).last();
  const asked = await button.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (!asked) return;
  await button.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
}
