import { SPA_HEADERS, gotoRoute, inDays, purge, test, expect } from "./fixtures";

// What you may do to an interview depends on where it is.
//
// A scheduled interview offers three things - mail the candidate their slot, mark it done, call it off - and
// a finished one offers none of them: pressing "Done" on an interview that already happened is how a panel
// ends up with two scorecards, and mailing one is how a candidate gets a second invitation to a slot that has
// been and gone. Which verbs are drawn is decided per row, in the browser, from that row's state and the
// caller's own `access.can`, and it is the whole of this feature's safety.
//
// `interviews` covers scheduling one and filling in its scorecard; `test/ats.test.ts` owns the transitions.
// What only a browser shows is the row changing what it offers as the interview moves.
test("a scheduled interview offers its moves, and a finished one offers none", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const admin = await as("super"); // the hard purge is an admin's to make
  // The round's name, which is what puts THIS interview's row beyond doubt: the page lists the org's other
  // interviews too, and every button below is pressed on a row rather than on the page.
  const round = `E2E round ${Date.now() % 1_000_000}`;

  // Hung on an application of this spec's OWN. Composing one through the dialogs is `ats`' subject, so the
  // chain is written over the wire in three calls - but it is written: the seed ships no applications at all,
  // and an interview hung on whatever another spec happened to leave behind passes in a full lane and fails
  // the moment this file is run on its own.
  const chain = await makeApplication(page, round);
  const created = await page.request.post("/v1/interviews", {
    headers: SPA_HEADERS,
    data: {
      application: chain.application,
      title: round,
      mode: "video",
      scheduled_start_time: `${inDays(3)}T10:00:00.000Z`,
      scheduled_end_time: `${inDays(3)}T10:45:00.000Z`,
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "interviews", "Interviews");
    const row = interviewRow(page, round);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Scheduled");

    // Scheduled: all three moves offered, each named for what it does to the candidate rather than to the row.
    await expect(row.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Cancel interview" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Email the candidate" })).toBeVisible();

    // Marked done, which is the move a panel makes after the call - and which asks first, because it takes
    // the interview off the schedule and puts the panel on the hook for scorecards.
    await row.getByRole("button", { name: "Done", exact: true }).click();
    const ask = page.getByRole("dialog").filter({ hasText: "Mark this interview as done?" });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await ask.getByRole("button", { name: "Mark done", exact: true }).click();
    await expect.poll(() => status(page, path), { timeout: 30_000 }).toBe("done");

    // And now it offers none of them - drawn from the state, not merely refused by the server afterwards. An
    // offered button that 409s is a worse experience than an absent one, and only a browser can tell them
    // apart.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    const finished = interviewRow(page, round);
    await expect(finished).toContainText("Done", { timeout: 30_000 });
    await expect(finished.getByRole("button", { name: "Cancel interview" })).toHaveCount(0);
    await expect(finished.getByRole("button", { name: "Email the candidate" })).toHaveCount(0);
    await expect(finished.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
    // The scorecard is the one thing a finished interview still owes, so it stays.
    await expect(finished.getByRole("button", { name: "Scorecard" })).toBeVisible();
  } finally {
    await purge(admin, path);
    // Innermost first: an application still pointing at them is what a candidate/requisition purge trips on.
    for (const p of chain.cleanup) await purge(admin, p);
  }
});

/** The list row for the interview whose round is `round`. */
function interviewRow(page: import("@playwright/test").Page, round: string) {
  // The rows are the bordered blocks of the list; filtering the whole set by the round's name picks one, and
  // scoping every press to it is what keeps this spec off the seed's own interviews.
  return page.locator("div.rounded-lg.border").filter({ hasText: round }).first();
}

/**
 * A requisition, a candidate, and the application between them - all this spec's own.
 *
 * `cleanup` is in purge order (the application before the two rows it points at).
 */
async function makeApplication(
  page: import("@playwright/test").Page,
  round: string,
): Promise<{ application: string; cleanup: string[] }> {
  const post = async (collection: string, data: Record<string, unknown>) => {
    const res = await page.request.post(`/v1/${collection}`, { headers: SPA_HEADERS, data });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { path: string }).path;
  };
  const requisition = await post("job-requisitions", { title: `${round} role` });
  const candidate = await post("candidates", { name: `${round} candidate` });
  const application = await post("applications", { requisition, candidate });
  return { application, cleanup: [application, candidate, requisition] };
}

/** The interview's state, as the server records it. */
async function status(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { status?: string }).status;
}
