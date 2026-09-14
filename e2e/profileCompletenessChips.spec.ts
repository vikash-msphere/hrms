import { SPA_HEADERS, gotoRoute, expect, test } from "./fixtures";

// The profile-completeness widget on a colleague's own record - never opened by any spec, on either of its
// two homes (`/profile`, the self-service nudge, or here, HR's neutral "This record is incomplete" framing). A
// brand-new employee has nothing filled in beyond a name, so every tracked section reads incomplete - the
// one state that needs no setup of its own to reach, and the chips are real navigation, not just paint:
// pressing one has to land on the section it names.
//
// Driven as super, not HR: the Bank details chip below opens that field-precise sub-resource
// (`piiTabAccess.spec.ts` - HR's broad `employees.write` deliberately does not reach it, only the owner and
// super do), so HR would 403 into a page that never offers the tab this spec presses.
test("a bare-new employee's record reads 0% complete, and each missing chip opens its own section", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const stamp = Date.now();

  const made = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: "E2E", last_name: `Bare${stamp}`, work_email: `e2e.bare.${stamp}@example.com` },
  });
  expect(made.status(), await made.text()).toBe(200);
  const employee = (await made.json()) as { path: string };
  const id = employee.path.split("/").pop();

  try {
    await gotoRoute(page, `employees/${id}`);
    await expect(page.getByText("This record is incomplete")).toBeVisible({ timeout: 30_000 });
    // Signature is left out of HR's tally entirely (it has no section on this page), so a brand-new record
    // is 0 of 6, not 0 of 7.
    // The score and the tally are separate elements now (the percentage is set large beside the count), so
    // they are asserted as the two things they are rather than as one run of text.
    await expect(page.getByText("0%", { exact: true })).toBeVisible();
    await expect(page.getByText("0 of 6 done")).toBeVisible();
    const bar = page.getByRole("progressbar", { name: "Profile completeness" });
    await expect(bar).toHaveAttribute("aria-valuenow", "0");

    // A tab, reached by a real navigation - not just a local tab switch that a reload would lose.
    await page.getByRole("button", { name: "Bank details", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`employees/${id}/bank$`));
    await expect(page.getByRole("tab", { name: /Bank details/ })).toHaveAttribute("aria-selected", "true");

    // Emergency contact opens its own dialog instead - a chip is not one shape throughout. Back to the
    // overview through the Profile tab rather than the browser's Back: the chip's own navigation is already
    // proven by the URL assertion above, and `page.goBack()` on this hash route fires no `hashchange` at all
    // (verified against the app's own listener), so the spec would be asserting against a page that never
    // navigated.
    await page.getByRole("tab", { name: "Profile", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`employees/${id}$`));
    await expect(page.getByText("This record is incomplete")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Emergency contact", exact: true }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Emergency details" })).toBeVisible({ timeout: 15_000 });
  } finally {
    const got = await page.request.get(`/v1/${employee.path}`);
    if (got.ok()) {
      const { etag } = (await got.json()) as { etag: string };
      await page.request.delete(`/v1/${employee.path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
    }
  }
});
