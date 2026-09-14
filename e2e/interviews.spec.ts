import { SPA_HEADERS, gotoRoute, inDays, purge, expect, test } from "./fixtures";

// Booking an interview, and scoring it.
//
// The scheduling form is the shared time-range control again, this time in front of a candidate: a round
// name, who is being interviewed, and the window it runs in. What only a browser shows is that the
// application picker reaches the person (an interview with nobody in it is the failure mode), that the
// window composes, and that the round then appears on the interviews page with the scorecard the panel is
// expected to file. `test/ats.test.ts` owns the records.
test("an interview is scheduled against an application and appears on the page", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const stamp = Date.now();
  const candidate = `E2E Interviewee ${stamp}`;
  const role = `E2E Interview Role ${stamp}`;

  // The people and the job are the pipeline's business (`ats`), so they arrive through the API and this
  // spec stays about the interview.
  const req = await create(page, "job-requisitions", { title: role, openings: 1 });
  const cand = await create(page, "candidates", { name: candidate, email: `e2e.iv.${stamp}@example.com` });
  await create(page, "applications", { candidate: cand, requisition: req, stage: "screening" });

  await gotoRoute(page, "interviews", "Interviews");
  await page.getByRole("button", { name: "Schedule interview" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Schedule an interview" })).toBeVisible();

  // Who: the application picker, which is how an interview is attached to a person on a job.
  await form.getByLabel("Application").click();
  await page.getByPlaceholder(/Search/).last().fill(candidate);
  await expect(page.getByRole("option", { name: new RegExp(candidate) })).toBeVisible();
  await page.keyboard.press("Enter");

  await form.getByLabel("Round").fill("Screening call");
  // When: the same range control the overtime form uses - a day, a start, and a duration chip for the end.
  await form.getByLabel("Date", { exact: true }).fill(inDays(3));
  await form.getByLabel("Time", { exact: true }).first().fill("10:00 AM");
  await form.getByLabel("Time", { exact: true }).first().blur();
  await form.getByRole("button", { name: "45m", exact: true }).click();

  await form.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // It is on the page, named by the round and the person it is with, with the scorecard the panel owes.
  const row = page.locator("div.rounded-lg.border").filter({ hasText: candidate }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Screening call");
  await expect(row.getByRole("button", { name: "Scorecard" })).toBeVisible();

  await purgeMatching(page, "interviews", (r) => (r.title ?? "") === "Screening call");
  await purgeMatching(page, "applications", (r) => (r.candidate ?? "") === cand);
  await purge(page, cand);
  await purge(page, req);
});

/** Create a row through the API and hand back its path. */
async function create(
  page: import("@playwright/test").Page,
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  const res = await page.request.post(`/v1/${collection}`, { headers: SPA_HEADERS, data });
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
