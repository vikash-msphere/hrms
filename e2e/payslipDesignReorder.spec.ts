import { gotoRoute, test, expect } from "./fixtures";

// The payslip design's own reorder controls - `payslipDesign.spec.ts` proves a block survives being added,
// edited, saved and removed, but never touches "Move up"/"Move down", the only way this stack is reordered
// (there is no drag handle). A swap that moves the wrong block, or moves it but leaves the row it displaced
// sitting in the same slot, reads as correct on a quick glance and wrong on every payslip after it.
//
// Never saved: the two blocks this spec adds are removed again before the test ends, and Save is never
// called, so the org's real design is untouched regardless of how the test ends.
test("Move up/down swaps a block with its neighbour, and back again", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  await gotoRoute(page, "settings/payslip-design");
  await expect(page.locator("h1").first()).toHaveText("Payslip design");

  const panel = () => page.getByRole("tabpanel");
  // One entry per block, in order. Anything shaped like "a div containing a Remove button" also matches every
  // ANCESTOR of one, so `nth(i)` off that list points at a container rather than the i-th block.
  const rows = () => panel().getByRole("listitem");
  const titles = () => rows().locator("span.text-sm.font-medium").allInnerTexts();

  // Two distinct kinds, appended in a known order, so a swap is visible in the titles themselves rather than
  // needing to open each block.
  // "Add <kind>" is the palette; a bare "<kind>" is a block already in the list (the stock design ships a
  // Spacer of its own), and the two are only telling apart by name.
  await panel().getByRole("button", { name: "Add Spacer" }).click();
  await panel().getByRole("button", { name: "Add Note" }).click();
  const before = await titles();
  expect(before.slice(-2)).toEqual(["Spacer", "Note"]);

  // Move the last block ("Note") up one: it and its neighbour swap places, not just the label in one slot.
  await rows().last().getByRole("button", { name: "Move up" }).click();
  const afterUp = await titles();
  expect(afterUp.slice(-2)).toEqual(["Note", "Spacer"]);
  expect(afterUp.slice(0, -2)).toEqual(before.slice(0, -2));

  // And back down: the same swap, reversed, lands exactly where it started.
  await rows().nth(afterUp.length - 2).getByRole("button", { name: "Move down" }).click();
  const afterDown = await titles();
  expect(afterDown).toEqual(before);

  // A block at either end has nothing to swap with - the button says so rather than wrapping around.
  await expect(rows().first().getByRole("button", { name: "Move up" })).toBeDisabled();
  await expect(rows().last().getByRole("button", { name: "Move down" })).toBeDisabled();

  // Taken back out in reverse, leaving the design exactly as this spec found it - and never saved.
  await rows().last().getByRole("button", { name: "Remove block" }).click();
  await rows().last().getByRole("button", { name: "Remove block" }).click();
  const restored = await titles();
  expect(restored).toEqual(before.slice(0, -2));
});
