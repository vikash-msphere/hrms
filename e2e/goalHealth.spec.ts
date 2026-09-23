import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The goal that says it is in trouble.
//
// Pace, silence and the progress sparkline are all derived server-side, so `test/goalHealth.test.ts` owns
// whether the numbers are right. What only exists in the browser is the loop a person actually walks: flag a
// goal off track from its drawer, see the card say so, find it again through the "At risk" filter, and read
// the shape of its progress rather than one percentage.
//
// Confidence is the half of "at risk" a spec can produce on demand - pace needs a goal that was set weeks ago,
// and the API will not let a test back-date one.
test("an owner flags a goal off track, and the page starts saying so", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("manager");
  const admin = await as("super"); // the hard purge is an admin's to make
  const title = `E2E health goal ${Date.now() % 1_000_000}`;

  const created = await page.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { title, description: "Raised by the goal-health spec.", weight: 40, due_date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) },
  });
  expect(created.status(), await created.text()).toBe(200);
  const goalPath = ((await created.json()) as { path: string }).path;

  try {
    // Two moves, so the drawer has a shape to draw rather than a single point.
    for (const progress of [20, 45]) {
      const moved = await page.request.post(`/v1/${goalPath}:updateProgress`, { headers: SPA_HEADERS, data: { progress } });
      expect(moved.status(), await moved.text()).toBe(200);
    }

    await gotoRoute(page, `goals/${goalPath.split("/")[1]}`);
    const detail = page.getByRole("dialog");
    await expect(detail.getByText(title).first()).toBeVisible({ timeout: 30_000 });

    // The health block: what the server expects by now, and the climb that produced today's number.
    await expect(detail.getByText(/45% against \d+% expected/)).toBeVisible({ timeout: 30_000 });
    await expect(detail.getByRole("img", { name: "Progress over time" })).toBeVisible();

    // The owner's own call, through the narrow verb - no edit form, no full edit rights needed.
    await detail.getByRole("button", { name: "Off track", exact: true }).click();
    await expect(toast(page, "Marked off track")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await goalOf(page, goalPath))?.confidence, { timeout: 30_000 }).toBe("off_track");

    // Back on the wall of cards: the flag rides the card, and the filter finds it by name.
    //
    // Closed by its own button rather than by Escape, because a toast is a dismissable layer of its own (radix
    // toast wraps each one in `DismissableLayer.Root`) and it is the newest - so with "Marked off track" still
    // on screen the first Escape takes the TOAST and the drawer stays exactly where it was.
    await detail.getByRole("button", { name: "Close" }).click();
    await expect(detail).toHaveCount(0, { timeout: 30_000 });
    await gotoRoute(page, "goals", "Goals");
    const card = page.locator("div").filter({ hasText: title }).last();
    await expect(card.getByText("Off track")).toBeVisible({ timeout: 30_000 });
    const atRisk = page.getByRole("button", { name: /^At risk/ });
    await expect(atRisk).toBeVisible({ timeout: 30_000 });
    await atRisk.click();
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await purge(admin, goalPath);
  }
});

/** One goal as the API has it. */
async function goalOf(page: import("@playwright/test").Page, path: string) {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return (await res.json()) as { confidence?: string; pace?: string; stale_days?: number };
}
