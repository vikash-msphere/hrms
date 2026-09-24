import { gotoRoute, test, expect } from "./fixtures";

// The "Request access" button on the wall a route puts up for a collection the caller can't read
// (web/src/components/common/NoAccess.tsx). The verb it calls (`access-rules:requestAccess`) is fail-closed
// and NOT granted to `everyone` in this seed, so the button could only ever 403 here. Under "hide, never
// disable" it must not render: the wall still says who to ask, and the button appears once an org grants the
// verb to Everyone.
test("the wall offers no Request access button when the org hasn't enabled the flow", async ({ as }) => {
  test.setTimeout(60_000);
  const page = await as("employee");

  await gotoRoute(page, "payroll-runs");
  await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Ask an access admin for payroll runs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
});
