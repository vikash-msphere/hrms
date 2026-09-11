import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The other way a box moves - dragged onto its new parent, not picked from the dialog.
//
// `orgChart.spec.ts` proves the picker path end to end; both paths call the same `applyMove`, so the RESULT
// isn't new. What is untested is the drag wiring itself: a real HTML5 drag needs `dragover` prevented (or the
// drop never fires at all - `fileDrop.spec.ts` hits the identical browser fact for file drops), the `validDrop`
// guard runs live off `dragover` to light up the target, and the drop handler reads back `dragId`/`dropId`
// state nothing else ever exercises. Departments, not people, for the same reason `orgChart.spec.ts` gives:
// two throwaway departments disturb nothing else in the seeded org.
test("a department is reparented by dragging it onto its new parent", async ({ as }) => {
  const page = await as("super");
  const stamp = Date.now();
  const parentName = `E2E drag parent ${stamp}`;
  const childName = `E2E drag child ${stamp}`;
  const parent = await makeDept(page, parentName);
  const child = await makeDept(page, childName);

  await gotoRoute(page, "org-chart", "Org Chart");
  await page.locator('button:has-text("Departments")').click();
  await page.getByRole("button", { name: "Outline layout" }).click();

  const childRow = row(page, child);
  const parentRow = row(page, parent);
  await expect(childRow).toBeVisible();
  await expect(parentRow).toBeVisible();

  const childSel = `[data-org-id="${child.split("/")[1]}"]`;
  const parentSel = `[data-org-id="${parent.split("/")[1]}"]`;
  // Typed as a tuple: `noUncheckedIndexedAccess` widens a destructured `string[]` element to
  // `string | undefined`, which `querySelector` will not take.
  // One dispatch per `page.evaluate()`, not all three in one synchronous call: `onDragStart`'s `setDragId`
  // is a React state update, and React only commits it (re-rendering `onDragOver` with a closure that sees
  // the NEW `dragId`) once this script yields back to the event loop. Fired back-to-back with no yield in
  // between, `onDragOver` would still be running off the PRE-drag closure - `dragId` reads as null,
  // `validDrop` returns false, and the drop looks rejected for a reason that has nothing to do with the
  // feature under test.
  const dt = "window.__e2eDragDt";
  await page.evaluate(([from, id]: [string, string]) => {
    (window as unknown as Record<string, DataTransfer>)[id] = new DataTransfer();
    const src = document.querySelector(from) as HTMLElement | null;
    src?.dispatchEvent(new DragEvent("dragstart", { dataTransfer: (window as unknown as Record<string, DataTransfer>)[id], bubbles: true, cancelable: true }));
  }, [childSel, dt] as [string, string]);
  const dropped = await page.evaluate(([to, id]: [string, string]) => {
    const dst = document.querySelector(to) as HTMLElement | null;
    const transfer = (window as unknown as Record<string, DataTransfer>)[id];
    if (!dst || !transfer) return false;
    const over = new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true });
    dst.dispatchEvent(over);
    dst.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    delete (window as unknown as Record<string, DataTransfer>)[id];
    return over.defaultPrevented; // false would mean the target never lit up as a valid drop
  }, [parentSel, dt] as [string, string]);
  expect(dropped, "the target never accepted the drag (dragover was not prevented)").toBe(true);

  // The same confirm the picker path shows - dragging isn't a shortcut around asking first.
  const ask = page.getByRole("dialog").filter({ hasText: `Move ${childName}?` });
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await expect(ask.getByText(`${childName} will sit under ${parentName}.`)).toBeVisible();
  await ask.getByRole("button", { name: "Move", exact: true }).click();
  await expect(toast(page, "Reporting line updated")).toBeVisible({ timeout: 30_000 });

  // Really moved, not just re-rendered: a reload rebuilds the tree from the server's own `parent` ref.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await page.locator('button:has-text("Departments")').click();
  await page.getByRole("button", { name: "Outline layout" }).click();
  await row(page, parent).getByTitle("Focus on this subtree").click();
  await expect(row(page, child)).toBeVisible();

  await purge(page, child);
  await purge(page, parent);
});

/** A department created straight through the API - this spec is about the drag, not the create form. */
async function makeDept(page: import("@playwright/test").Page, display_name: string): Promise<string> {
  const res = await page.request.post("/v1/departments", { headers: SPA_HEADERS, data: { display_name } });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** The outline layout's row for a department, found by the wire id the page stamps onto it. */
function row(page: import("@playwright/test").Page, path: string) {
  return page.locator(`[data-org-id="${path.split("/")[1]}"]`);
}
