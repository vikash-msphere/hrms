import { SPA_HEADERS, gotoRoute, inDays, personPath, purge, test, expect } from "./fixtures";

// Taking your approvals back.
//
// A delegation redirects somebody else's decisions to a stand-in while they are away, so ending one is not a
// tidy-up - it changes who is allowed to decide, from that moment on. The browser owes the person pressing it
// a sentence naming both people ("approvals stop going to X and return to Y"), because the row itself is two
// names and a date range and reads the same either way round.
//
// `delegations` covers composing one - the form stating what it will do, and the warning when the days are
// already covered. `test/` owns the redirect. What only a browser shows is the ending: the question naming
// both sides, and the row going.
test("a delegation is ended, after the question names who gets their approvals back", async ({ as }) => {
  test.setTimeout(180_000);
  // As super, like `delegations`: nothing grants `approval-delegations` to a role in the demo matrix, so it
  // is private-by-default and an admin is who reaches the page at all.
  const page = await as("super");

  // Leftovers first. The window below is fixed, and the server refuses a second delegation overlapping one
  // that already stands - so a run that died before its own cleanup would block every run after it.
  await sweepLeftovers(page);

  // A delegation of this spec's own, written over the wire - composing one is `delegations`' subject. Dated
  // well into the future so it can never collide with the window another spec's delegation covers.
  const created = await page.request.post("/v1/approval-delegations", {
    headers: SPA_HEADERS,
    data: {
      delegator: await personPath(page, "hr"),
      delegate: await personPath(page, "manager"),
      from_date: inDays(120),
      to_date: inDays(127),
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "delegations", "Approval delegation");
    const row = page.locator("tbody tr").filter({ hasText: "Mara Manager" }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "Remove delegation" }).click();
    // Both names in the question: the row is two people, and undoing the wrong one hands somebody else's
    // decisions to the wrong stand-in.
    const ask = page.getByRole("dialog").filter({ hasText: "Remove this delegation?" });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask.getByText(/Approvals stop going to Mara Manager/)).toBeVisible();
    await ask.getByRole("button", { name: "Remove", exact: true }).click();

    // Gone on the server - the redirect really stops rather than the row merely disappearing from the page.
    await expect.poll(() => alive(page, path), { timeout: 30_000 }).toBe(false);
  } finally {
    await purge(page, path);
  }
});

/** Whether the delegation is still standing. */
async function alive(page: import("@playwright/test").Page, path: string): Promise<boolean> {
  const res = await page.request.get(`/v1/${path}`);
  if (res.status() === 404) return false;
  if (!res.ok()) return true;
  return !((await res.json()) as { delete_time?: string }).delete_time;
}

/** Delegations an earlier run of this spec left standing in its own window. */
async function sweepLeftovers(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/approval-delegations?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; from_date?: string }[] };
  for (const d of results.filter((x) => x.from_date === inDays(120))) await purge(page, d.path);
}
