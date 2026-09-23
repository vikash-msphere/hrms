import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Awarding a referral bonus by hand, before the milestone cron would ever get to it.
//
// `referrals.spec.ts` walks the form and the pipeline hand-off but deliberately abandons the edit before the
// referral is ever hired; `referralJoinTiers.spec.ts` and `test/referrals.test.ts` own the tiered-amount
// arithmetic the daily cron applies. What neither ever presses is "Award now" itself - the manual override an
// HR admin uses instead of waiting for probation to end, which is real state on the wire (bonus_status flips
// pending -> eligible and a `bonuses` row is created) and its own confirm dialog.
test("a referral's bonus is awarded by hand once the hire is linked", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E award referral ${Date.now() % 100000}`;

  const emps = await page.request.get("/v1/employees?page_size=1");
  expect(emps.status(), await emps.text()).toBe(200);
  const employee = ((await emps.json()) as { results?: { path: string }[] }).results?.[0];
  expect(employee, "no seeded employee to link the hire to").toBeTruthy();

  // `status` defaults to "submitted" at create regardless of what's posted (the service hardcodes it) - so
  // the move to "hired" rides the same PATCH as linking the hire, below.
  const made = await page.request.post("/v1/referrals", { headers: SPA_HEADERS, data: { candidate_name: name } });
  expect(made.status(), await made.text()).toBe(200);
  const created = (await made.json()) as { path: string; etag: string };

  // Linked over the wire: getting a referral all the way to an actual hired-and-joined employee is the whole
  // ATS pipeline's own subject (`ats.spec.ts`, `offers.spec.ts`) - this needs only the link itself, which is
  // exactly what "Award now" checks for.
  //
  // No If-Match: sending the create response's own etag right back on the very next PATCH 409s here as
  // "etag mismatch" against a value a GET taken immediately before that same PATCH shows as current - and it
  // is fully deterministic (reproduces on a freshly created, otherwise-untouched referral, with no other
  // request in flight, and survives a 500ms wait and a refetch-and-retry immediately before resending), so it
  // is not a race this test lost. Nothing under src/services/referrals.ts, the shared crud factory, or the
  // openapi schema explains it - a real anomaly, reported rather than silently routed around, and left for
  // someone with server-side visibility this harness doesn't give. This step itself has no reason to need
  // optimistic-concurrency protection (nothing else is touching this row yet), so it proceeds unconditionally.
  const linked = await page.request.patch(`/v1/${created.path}`, {
    headers: SPA_HEADERS,
    data: { status: "hired", hired_employee: employee!.path },
  });
  expect(linked.status(), await linked.text()).toBe(200);

  let bonusPath: string | undefined;
  try {
    await gotoRoute(page, "referrals", "Referrals");
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    const award = row.getByRole("button", { name: "Award now" });
    await expect(award).toBeVisible({ timeout: 30_000 });
    await award.click();

    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("Award the referral bonus now?")).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole("button", { name: "Award", exact: true }).click();
    // "Bonus awarded" also appears as the row's own new status badge and the toast's live-region echo -
    // scoped to the toast itself rather than any element on the page carrying the same text.
    await expect(toast(page, "Bonus awarded")).toBeVisible({ timeout: 30_000 });

    // Read back: the flat default applies (no join tier configured for this hire), and awarding claims the
    // referral - a second press must find nothing left to award.
    const after = await page.request.get(`/v1/${created.path}`);
    const body = (await after.json()) as { bonus_status?: string; bonus_amount?: number; bonus?: string };
    expect(body.bonus_status).toBe("eligible");
    expect(body.bonus_amount).toBeGreaterThan(0);
    expect(body.bonus).toBeTruthy();
    bonusPath = body.bonus;
    await expect(row.getByRole("button", { name: "Award now" })).toHaveCount(0);
  } finally {
    if (bonusPath) await purge(page, bonusPath);
    await purge(page, created.path);
  }
});
