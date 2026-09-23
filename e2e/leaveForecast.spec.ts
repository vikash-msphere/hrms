import { gotoRoute, test, expect } from "./fixtures";

// What a leave balance is about to DO, not just what it is today.
//
// `lib/leaveForecast.ts` imports the server's own accrual (src/domain/leave.ts) and carry-forward
// (src/domain/carryForward.ts) math directly rather than restating it, so the arithmetic is pinned against
// drift wherever that lives. What only a browser shows is the line actually landing on the balance card it
// belongs to - the next credit ("+1.5 on 1 Oct") or what the year end takes back ("2 lapses on 31 Dec") - next
// to the number it explains, not a separate report nobody thinks to open.
test("a balance card forecasts its next credit or its year-end fate", async ({ as }) => {
  const page = await as("employee");

  await gotoRoute(page, "leave-requests", "Leaves");
  // "days left" is only on the caller's own balance cards (the my-balances row), not the admin table beside
  // it - so this is scoped to a real card rather than to the whole page.
  const cards = page.locator('div[role="button"]').filter({ hasText: "days left" });
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });

  // At least one of this employee's own types accrues or carries a cap - the seeded Annual type does both -
  // so somewhere in this row is the forecast line the feature exists to draw.
  const forecast = cards.locator("p").filter({ hasText: /^\+[\d.]+ on |lapses on 31 Dec|auto-encashed on 31 Dec/ });
  await expect(forecast.first()).toBeVisible({ timeout: 15_000 });
});
