import { gotoRoute, purge, test, expect } from "./fixtures";

// Referring somebody, and what happens to the referral afterwards.
//
// `test/referrals.test.ts` owns the bonus milestone job. What only a browser has is the referrer's side of it:
// a form that says what each status MEANS for the bonus while it is being picked (a referral is one of the
// few places money depends on a dropdown), and the one-click hand-off that turns a referral into a candidate
// in the hiring pipeline - a bridge between two collections that exists only on this page.
test("a referral is made, its status explains the bonus, and it hands over to the pipeline", async ({ as }) => {
  test.setTimeout(180_000);
  // Super: referrals ship private with no seeded role grants (src/domain/grants.ts), so an org decides who
  // may see them - and until it does, only a super admin can.
  const page = await as("super");
  const name = `E2E Referral ${Date.now() % 100000}`;

  await gotoRoute(page, "referrals", "Referrals");
  await page.getByRole("button", { name: "Refer someone" }).first().click();
  const form = page.getByRole("dialog");

  await form.getByLabel("Candidate name").fill(name);
  await form.getByLabel("Position (optional)").fill("Senior Engineer");
  // An address that isn't one is caught here rather than by a bounced email nobody sees.
  await form.getByLabel("Email (optional)").fill("not-an-email");
  await form.getByLabel("Email (optional)").blur();
  await expect(form.getByText(/valid email|Not an email|email address/i).first()).toBeVisible();
  await form.getByLabel("Email (optional)").fill(`e2e.referral.${Date.now()}@example.com`);
  await form.getByLabel("Notes (optional)").fill("Worked with them for two years; ships and explains.");
  await form.getByRole("button", { name: "Submit referral" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row).toHaveCount(1);

  // Status is where the money is decided, so the form says the consequence of each one as it is picked -
  // "no bonus is owed" is not something to discover after the fact.
  await row.getByRole("button", { name: /Edit|Update/ }).first().click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Status").click();
  await page.getByRole("option", { name: "Hired" }).click();
  await expect(editor.getByText("Hired. Link the employee below and the bonus becomes awardable.")).toBeVisible();
  await editor.getByLabel("Status").click();
  await page.getByRole("option", { name: "Rejected" }).click();
  await expect(editor.getByText("Closed. No bonus is owed.")).toBeVisible();
  // Abandoned rather than saved: what is being tested is what the form SAYS about each status, and closing
  // somebody's referral is not this spec's business. Backing out of a changed form asks first, which is the
  // draft guard doing its job.
  await editor.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await expect(discard).toBeVisible();
  await discard.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The hand-off: a referral is not an application until somebody puts it in the pipeline, and doing that
  // creates a candidate sourced from this referral - which is a real write into another collection, so it
  // asks first.
  await row.getByRole("button", { name: "To pipeline" }).click();
  await expect(page.getByText("Add to the candidate pipeline?")).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(row.getByRole("button", { name: "In pipeline" })).toBeVisible({ timeout: 30_000 });

  await purgeCandidate(page, name);
  await purgeReferral(page, name);
});

/** Drop the candidate the hand-off created. */
async function purgeCandidate(page: import("@playwright/test").Page, name: string) {
  const res = await page.request.get("/v1/candidates?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => x.name === name)) await purge(page, c.path);
}

/** Drop the referral this spec made. */
async function purgeReferral(page: import("@playwright/test").Page, name: string) {
  const res = await page.request.get("/v1/referrals?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; candidate_name?: string }[] };
  for (const r of results.filter((x) => x.candidate_name === name)) await purge(page, r.path);
}
