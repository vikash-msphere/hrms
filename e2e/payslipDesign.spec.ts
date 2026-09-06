import { gotoRoute, test, expect } from "./fixtures";
import { extractPdfText } from "./pdfText";

// The payslip layout editor, which is a document designer inside a settings panel.
//
// `test/payslipTemplate.test.ts` owns what the stored blocks mean and `test/payslipPdf.test.ts` renders them.
// What only a browser has is the editing loop: a stack of blocks that is added to, opened, edited and removed,
// a Save that stays disabled until something actually changed, a "restore the stock design" that asks first,
// and a live preview that re-renders the PDF a beat after each edit. A designer that loses the block you just
// added, or previews the design you had before, is broken in a way no server test sees.
test("a block is added to the payslip design, previewed, saved and taken back out", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  await gotoRoute(page, "settings/payslip-design");
  await expect(page.locator("h1").first()).toHaveText("Payslip design");

  const panel = () => page.getByRole("tabpanel");
  const title = page.getByText(/^Blocks \(\d+\)$/).first();
  const countOf = async () => Number((await title.innerText()).match(/\((\d+)\)/)?.[1] ?? 0);
  // The panel's own Save. The unsaved-changes banner that pins above it while the design is dirty offers
  // "Save all", which is a different act (every dirty form in the panel) and so a different name.
  const save = () => page.getByRole("button", { name: "Save", exact: true });

  // Start from the stock design, so the count this test reasons about is the built-in one rather than
  // whatever a previous run left behind. Restoring is destructive, so it asks first - and it changes nothing
  // until Save, which is the promise the confirm makes.
  await page.getByRole("button", { name: "Stock design" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  if (await save().isEnabled()) await save().click();
  await expect(save()).toBeDisabled();
  const before = await countOf();
  expect(before).toBeGreaterThan(0);

  // A note is the block with text of its own, so it is the one whose survival can be read off the page.
  await panel().getByRole("button", { name: "Add Note" }).click();
  await expect(title).toHaveText(new RegExp(`\\(${before + 1}\\)`));
  await expect(save()).toBeEnabled();
  await save().click();
  await expect(save()).toBeDisabled();

  // Read back from cold: the design is org-wide config, so the block has to come back from the server rather
  // than from the editor's own state.
  await page.reload();
  await expect(page.locator("h1").first()).toHaveText("Payslip design");
  await expect(title).toHaveText(new RegExp(`\\(${before + 1}\\)`), { timeout: 30_000 });

  // The block opens for editing, and its fields belong to its kind: a note has text, a spacer would not.
  // Located by the row's own controls rather than by the word "Note", which names a block AND (as "Add Note")
  // the button that appends one.
  const lastRow = () => panel().getByRole("listitem").last();
  await lastRow().getByRole("button").first().click();
  const noteText = `E2E note ${Date.now() % 100000}`;
  await panel().getByLabel("Text").last().fill(noteText);
  await expect(panel().getByLabel("Text").last()).toHaveValue(noteText);

  // The preview is a real PDF render of the current design, debounced behind the edits - which is the only
  // way to see what a payslip will look like without publishing a payroll run at somebody.
  await page.getByRole("tab", { name: "Preview" }).click();
  const frame = page.getByTitle("Payslip design preview");
  await expect(frame).toBeVisible({ timeout: 60_000 });
  await expect(frame).toHaveAttribute("src", /^blob:/);

  // Not just A render - THIS one: the debounced preview has to have picked up the note actually typed above,
  // not the design from before it (or from before the render ever caught up). Read back from the blob itself,
  // since nothing else can see inside it.
  await expect(async () => {
    const src = await frame.getAttribute("src");
    const base64 = await page.evaluate(async (url) => {
      const buf = await (await fetch(url!)).arrayBuffer();
      let bin = "";
      for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
      return btoa(bin);
    }, src);
    const text = await extractPdfText(Buffer.from(base64, "base64"));
    expect(text).toContain(noteText);
  }).toPass({ timeout: 30_000 });

  // And out again, because every payslip generated after this test uses whatever is left here.
  await page.getByRole("tab", { name: "Blocks" }).click();
  await save().click();
  await expect(save()).toBeDisabled();
  await lastRow().getByRole("button", { name: "Remove block" }).click();
  await expect(title).toHaveText(new RegExp(`\\(${before}\\)`));
  await save().click();
  await page.reload();
  await expect(title).toHaveText(new RegExp(`\\(${before}\\)`), { timeout: 30_000 });
});
