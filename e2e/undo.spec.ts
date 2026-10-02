import { SPA_HEADERS, confirmDelete, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting something, and taking it back.
//
// A soft delete deliberately does NOT ask first (useSoftDelete.ts): the row goes, and the toast carries the
// Undo for the change of heart. That trade only holds if the Undo is really there and really works - if it
// is missed, or the restore silently fails, the app has quietly become a delete with no confirmation and no
// way back. The restore endpoint is the server suite's business; that the affordance appears, survives long
// enough to press, and puts the row back on screen is only true in a browser.
test("a soft delete offers an undo, and the undo brings the row back", async ({ as }) => {
  const page = await as("super");

  // Its own vendor, so this never deletes something another spec is looking at.
  const name = `E2E undo vendor ${Date.now()}`;
  const created = await page.request.post("/v1/vendors", { headers: SPA_HEADERS, data: { display_name: name } });
  expect(created.status(), await created.text()).toBe(200);

  await gotoRoute(page, "vendors", "Vendors");
  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row).toHaveCount(1);

  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

  // It asks first, says the way back, and once answered the row is gone with the way back in the toast.
  await expect(page.getByRole("dialog").getByText(/Undo on the message that follows brings it straight back/)).toBeVisible();
  await confirmDelete(page);
  await expect(page.locator("tbody tr").filter({ hasText: name })).toHaveCount(0);
  const deleted = toast(page, "Vendor deleted");
  await expect(deleted).toBeVisible();

  await deleted.getByRole("button", { name: "Undo" }).click();
  await expect(toast(page, "Vendor restored")).toBeVisible();
  await expect(page.locator("tbody tr").filter({ hasText: name })).toHaveCount(1);
});
