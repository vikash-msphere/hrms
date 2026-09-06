import { gotoRoute, test, expect } from "./fixtures";

// Dropping a file on the form instead of hunting for it.
//
// Every file field in the app is one component, and it takes a file three ways: a click that opens the
// picker, a photo on a phone, and a DROP. The third is the one no other spec exercises - `documentUpload`
// and `candidateResume` both go through the input - and it is pure browser: a `dragover` that has to be
// prevented (or the browser navigates away from the app to open the file), a `drop` whose `dataTransfer` is
// read for real files, and the field then redrawing as a named row with a way to take the file back off.
//
// A drop that silently does nothing is the failure this guards: the person sees their file vanish, and the
// form still says "choose a file".
test("a file dropped on the field is taken, named and removable", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");

  await gotoRoute(page, "documents", "Documents");
  await page.getByRole("button", { name: "Upload document" }).click();
  const form = page.getByRole("dialog");
  await expect(form).toBeVisible({ timeout: 30_000 });

  // Empty, and inviting: the field says both ways in are open.
  const field = form.locator("div.border-dashed").first();
  // The Documents field takes several files at once, so its invitation is the plural one.
  await expect(field).toContainText("drop them here");

  // A real drop: a DataTransfer built in the page, carrying a real File, dispatched at the field the way a
  // browser does it. `dragover` first, because a field that does not prevent it never receives the drop at
  // all - the browser opens the file instead, and the app is gone.
  const dropped = await field.evaluate(async (el, pdf: string) => {
    const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
    const file = new File([bytes], "dropped-policy.pdf", { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(over);
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    // `defaultPrevented` is the half a screenshot cannot show: without it the drop is the browser's, not the
    // app's.
    return over.defaultPrevented;
  }, PDF_BASE64);
  expect(dropped, "the field let the browser take the drop instead").toBe(true);

  // Taken, and named: the file the person dropped, with its size, in place of the invitation.
  await expect(field).toContainText("dropped-policy.pdf", { timeout: 30_000 });
  await expect(field).not.toContainText("drop them here");

  // And removable, because the commonest thing after dropping the wrong file is dropping the right one.
  await field.getByRole("button", { name: "Remove dropped-policy.pdf" }).click();
  await expect(field).toContainText("drop them here", { timeout: 30_000 });

  // Nothing was saved: this spec is about the field, not about the document.
  await page.keyboard.press("Escape");
  const discard = page.getByRole("button", { name: /^(Discard|Leave)$/ });
  if (await discard.count()) await discard.first().click();
});

/** The smallest thing a PDF reader will open, so the bytes are a real file rather than a blob of text. */
const PDF_BASE64 = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString(
  "base64",
);
