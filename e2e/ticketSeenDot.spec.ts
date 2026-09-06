import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// "Updated since you last opened it" - a dot only THIS browser can be right about.
//
// `lib/ticketsSeen.ts` is deliberately client-side: a read receipt per person per ticket would be a table and
// a write on every row scrolled past, to drive one dot. What it keeps is a map of ticket -> the `update_time`
// this browser last showed, plus a baseline stamped on first visit so a year of old history doesn't all light
// up at once. None of that is reachable from a server test - it lives in localStorage - so this is the only
// place the dot's actual rule (new since the baseline, gone once opened) is provable.
test("a ticket updated since the baseline carries a dot, and opening it clears one", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
  const subject = `E2E seen ${Date.now()}`;

  // A fresh browser context has no `tickets-last-seen` yet, so this first visit is what stamps the baseline -
  // BEFORE the ticket below exists, which is what makes it read as "new" rather than pre-dating the baseline.
  await gotoRoute(hr, "tickets", "Support");

  const made = await hr.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject, category: "it", description: "Raised by the e2e suite to prove the seen-dot." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  try {
    await hr.reload();
    await expect(hr.getByRole("main")).toBeVisible();
    const row = hr.locator("tbody tr").filter({ hasText: subject }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // The dot itself, named by its own title rather than by colour - which is exactly why title is asserted.
    await expect(row.getByTitle("Updated since you last opened it")).toBeVisible();

    await row.click();
    const detail = hr.getByRole("dialog");
    await expect(detail.getByText(subject).first()).toBeVisible({ timeout: 30_000 });
    await hr.keyboard.press("Escape");
    await expect(hr.getByRole("dialog")).toHaveCount(0);

    // Opening it stamped THIS ticket's update_time as seen - the dot is gone without the row's data changing
    // at all, which is the whole point of measuring against a browser-local reading rather than the server.
    await expect(row.getByTitle("Updated since you last opened it")).toHaveCount(0);
  } finally {
    await purge(hr, ticket.path);
  }
});
