import { allowConsoleErrors, gotoRoute, toast, test, expect } from "./fixtures";

// The "Request access" button on the wall a route puts up for a collection the caller can't read
// (web/src/components/common/NoAccess.tsx) - reached by several specs already (`payroll-runs` for the
// employee fixture, pinned by `accessPreview.spec.ts` among others), but never actually clicked before this.
// The verb it calls (`access-rules:requestAccess`) is itself fail-closed and NOT granted to `everyone` in
// this seed, so what this proves is the graceful half of the feature: an org that hasn't turned the flow on
// gets told so, plainly, rather than a raw 403 or a silently swallowed click.
test("Request access on a page the caller cannot read fails gracefully when the flow isn't enabled", async ({ as }) => {
  test.setTimeout(60_000);
  const page = await as("employee");
  // The 403 below is the SUBJECT of this spec, not a symptom: the request is meant to be refused, and what is
  // being checked is that the refusal arrives as a toast rather than a broken page. The browser logs every
  // failed request as a console error regardless, so the one this spec provokes on purpose is opted out of.
  allowConsoleErrors(page, /status of 403/i);

  await gotoRoute(page, "payroll-runs");
  await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });

  const request = page.getByRole("button", { name: "Request access" });
  await expect(request).toBeVisible();
  await request.click();

  // The button opens the ask rather than sending it: the request carries a reason and a duration for the
  // admin to act on (web/src/components/common/NoAccess.tsx), and nothing leaves the browser until Send.
  // Both are left at their defaults here - an empty reason and "Permanently" are what the plainest ask looks
  // like, and the refusal this spec is about does not depend on either.
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeVisible();
  await send.click();

  await expect(toast(page, "Couldn't send the request")).toBeVisible({ timeout: 15_000 });
  await expect(toast(page, "aren't enabled here yet")).toBeVisible();
});
