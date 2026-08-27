import { fileLeave, gotoRoute, test, expect, toast } from "./fixtures";

// Clearing a queue several at a time.
//
// The bulk bar is pure browser state: a selection set that survives scrolling, a bar that appears with it, a
// count that has to agree with what is ticked, one confirmation for the whole batch, and then N decisions
// whose results are merged into a single summary. The server sees only ordinary approve calls - there is
// nothing there to test. A bulk decision is also the most expensive thing in the app to get wrong, because
// it is several people's requests at once.
test("several requests can be decided together, once confirmed", async ({ as }) => {
  const page = await as("super");
  // Two of its own, so a bulk of two is always available however many runs have cleared the seeded queue.
  const employee = await as("employee");
  await fileLeave(employee, `E2E bulk a ${Date.now()}`);
  await fileLeave(employee, `E2E bulk b ${Date.now()}`);
  await gotoRoute(page, "approvals");

  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve.first()).toBeVisible();
  const waiting = await approve.count();
  expect(waiting, "the two requests filed above should be waiting here").toBeGreaterThanOrEqual(2);

  // Tick two of them. The checkbox names itself after whose request it is, so a mis-tick is visible.
  const boxes = page.getByRole("checkbox", { name: /Select .*'s request/ });
  await expect(boxes.first()).toBeVisible();
  await boxes.nth(0).check();
  await boxes.nth(1).check();

  // The bar appears with the selection and counts it.
  await expect(page.getByText("2 selected")).toBeVisible();

  // One confirmation for the batch, naming the number - a bulk decision must never be a single click either.
  await page.getByRole("button", { name: "Approve selected" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Approve 2 requests?")).toBeVisible();
  await confirm.getByRole("button", { name: "Approve all" }).click();

  // Both leave the queue, and the summary says what happened rather than leaving it to be inferred.
  await expect(toast(page, /Approved 2/)).toBeVisible();
  await expect(approve).toHaveCount(waiting - 2);
  await expect(page.getByText("2 selected")).toHaveCount(0);
});
