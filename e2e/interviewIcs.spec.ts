import { SPA_HEADERS, gotoRoute, inDays, purge, expect, test } from "./fixtures";

// An interview's own calendar invite - `calendarFeed.spec.ts` proves the all-day leave/holiday feed
// (`buildIcs`), but an interview is a TIMED event on a specific hour, built by a separate function
// (`buildTimedIcs`) that nothing in the suite has ever called. "Add to calendar" is the one place it runs:
// a panelist without it either misses the slot or has to retype it from the page by hand.
test("an interview's calendar invite names the round, the candidate and the window", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const stamp = Date.now();
  const candidate = `E2E ICS Interviewee ${stamp}`;
  const role = `E2E ICS Role ${stamp}`;

  const req = await create(page, "job-requisitions", { title: role, openings: 1 });
  const cand = await create(page, "candidates", { name: candidate, email: `e2e.ics.${stamp}@example.com` });
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
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      row.getByRole("button", { name: "Add to calendar" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^interview-.*\.ics$/);
    const path = await download.path();
    if (!path) throw new Error("the download produced no file");
    const { readFile } = await import("node:fs/promises");
    const ics = (await readFile(path)).toString("utf-8");

    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain(`SUMMARY:Screening call · ${candidate}`);
    expect(ics).toMatch(/UID:interview-[^@\r\n]+@hrms/);
    // A timed event, not an all-day one - DTSTART/DTEND carry a time-of-day, unlike the leave feed's bare date.
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).toMatch(/DTEND:\d{8}T\d{6}Z/);
    expect(ics.trim().endsWith("END:VCALENDAR")).toBe(true);
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
