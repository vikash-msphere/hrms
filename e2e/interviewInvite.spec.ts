import { apiPost, gotoRoute, inDays, purge, expect, test, toast } from "./fixtures";

// Emailing the candidate their own slot - `interviews.spec.ts` and `interviewIcs.spec.ts` both stop once the
// interview is scheduled and never touch this button. Scheduling has always notified the panel and left the
// candidate to be told by hand, which is exactly where a wrong time or a missing link comes from; this is
// the fix, and it asks first because it is a real email to a real person outside the org.
test("emailing the candidate their interview slot confirms first and reports who it went to", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const stamp = Date.now();
  const candidate = `E2E Invite Interviewee ${stamp}`;
  const role = `E2E Invite Role ${stamp}`;

  const req = await create(page, "job-requisitions", { title: role, openings: 1 });
  const cand = await create(page, "candidates", { name: candidate, email: `e2e.invite.${stamp}@example.com` });
  await create(page, "applications", { candidate: cand, requisition: req, stage: "screening" });

  await gotoRoute(page, "interviews", "Interviews");
  await page.getByRole("button", { name: "Schedule interview" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Application").click();
  await page.getByPlaceholder(/Search/).last().fill(candidate);
  await expect(page.getByRole("option", { name: new RegExp(candidate) })).toBeVisible();
  await page.keyboard.press("Enter");
  await form.getByLabel("Round").fill("Screening call");
  await form.getByLabel("Date", { exact: true }).fill(inDays(3));
  await form.getByLabel("Time", { exact: true }).first().fill("10:00 AM");
  await form.getByLabel("Time", { exact: true }).first().blur();
  await form.getByRole("button", { name: "45m", exact: true }).click();
  await form.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const row = page.locator("div.rounded-lg.border").filter({ hasText: candidate }).first();
  await expect(row).toBeVisible();

  try {
    await row.getByRole("button", { name: "Email the candidate" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: `Email ${candidate} their interview?` });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("with a calendar file attached", { exact: false })).toBeVisible();
    await confirm.getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(toast(page, `Invitation sent to ${candidate}`)).toBeVisible({ timeout: 30_000 });
  } finally {
    await purgeMatching(page, "interviews", (r) => (r.title ?? "") === "Screening call");
    await purgeMatching(page, "applications", (r) => (r.candidate ?? "") === cand);
    await purge(page, cand);
    await purge(page, req);
  }
});

/** Create a row through the API and hand back its path. */
async function create(
  page: import("@playwright/test").Page,
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  // `apiPost`, not a bare post: this is the spec's scaffolding (a requisition, a candidate, an interview to
  // invite somebody to), and the runtime recycling the Worker mid-request kills the whole test on a row it
  // was only setting up. The invite itself - what this test is about - is driven through the page.
  const res = await apiPost(page, collection, data);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** Purge every row of `collection` the predicate picks out. */
async function purgeMatching(
  page: import("@playwright/test").Page,
  collection: string,
  match: (row: Record<string, string>) => boolean,
) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) if (match(r)) await purge(page, r.path!);
}
