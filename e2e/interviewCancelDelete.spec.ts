import { SPA_HEADERS, allowConsoleErrors, gotoRoute, inDays, purge, test, expect } from "./fixtures";

// The two moves `interviewLifecycle.spec.ts` only ever checks are OFFERED, never presses: Cancel interview
// (its own test asserts the button is visible on a scheduled row and gone on a finished one, but the press
// itself - the confirm, the toast, the status actually flipping to "cancelled" - has never happened) and
// Delete (unconditional on any status, and untested at every status).
test("a scheduled interview is called off, and then deleted outright", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  // The 503 the cancel retry below recovers from: a dev Worker restart mid-request, the same rare hiccup
  // documented elsewhere in this suite (complianceRuleDelete.spec.ts et al.). The interview's own status,
  // polled at each step, is what proves the move landed.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  const admin = await as("super");
  const round = `E2E cancel round ${Date.now() % 1_000_000}`;

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

    // Re-pressed on a miss, gated on the interview's OWN status: a dev Worker restart mid-request answers the
    // confirm with a 503 and leaves the row scheduled with its Cancel button offered again, exactly as it
    // started - and asking the record first is what stops a retry pressing a decision that already landed.
    await expect(async () => {
      if ((await status(page, path)) === "cancelled") return;
      const press = row.getByRole("button", { name: "Cancel interview" });
      if (await press.count()) await press.click({ timeout: 8_000 });
      const ask = page.getByRole("dialog").filter({ hasText: "Cancel this interview?" });
      await expect(ask).toBeVisible({ timeout: 15_000 });
      await ask.getByRole("button", { name: "Cancel interview", exact: true }).click({ timeout: 8_000 });
      await expect.poll(() => status(page, path), { timeout: 15_000 }).toBe("cancelled");
    }).toPass({ timeout: 90_000 });
    await expect(row).toContainText("Cancelled", { timeout: 30_000 });

    // Cancelled offers no further move on the round (Done/Cancel/Email all close the same way `interviewLifecycle.
    // spec.ts` proves for a finished one) - only Edit and Delete remain, which is what makes deleting it next
    // the natural continuation rather than a separately-staged interview.
    await expect(row.getByRole("button", { name: "Cancel interview" })).toHaveCount(0);
    await row.getByRole("button", { name: "Delete" }).click();
    const del = page.getByRole("dialog").filter({ hasText: "Delete this interview?" });
    await expect(del).toBeVisible({ timeout: 30_000 });
    await del.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(interviewRow(page, round)).toHaveCount(0, { timeout: 30_000 });

    // Soft-deleted, not erased - but the default `get` DOES filter deleted rows out (the generic crud
    // factory's `get`, src/services/crud.ts, throws notFound on `deleteTime` for every collection), so
    // `show_deleted=true` on the list is the way to check, not a plain item GET.
    const after = await page.request.get(`/v1/interviews?show_deleted=true&page_size=200`);
    expect(after.ok(), await after.text()).toBe(true);
    const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
    const found = results.find((r) => r.path === path);
    expect(found?.delete_time, "the interview should survive soft-deleted, not be gone entirely").toBeTruthy();
  } finally {
    await purge(admin, path);
    for (const p of chain.cleanup) await purge(admin, p);
  }
});

function interviewRow(page: import("@playwright/test").Page, round: string) {
  return page.locator("div.rounded-lg.border").filter({ hasText: round }).first();
}

async function makeApplication(page: import("@playwright/test").Page, round: string): Promise<{ application: string; cleanup: string[] }> {
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

async function status(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { status?: string }).status;
}
