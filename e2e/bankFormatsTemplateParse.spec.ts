import * as XLSX from "xlsx";
import { gotoRoute, withAllowedBank, test, expect } from "./fixtures";

// The bank template is parsed IN THE BROWSER (web/src/pages/BankFormats.tsx `onTemplate`), before a byte of it
// reaches the server - `bankFormats.spec.ts` proves the happy path (a good template, mapped and saved), but
// three things the client does to a BAD or ODDLY-SHAPED file are its own and nothing server-side ever sees
// them: it rejects a file that isn't really a workbook, it rejects one over the same size ceiling the server
// enforces (mirrored client-side so the reader isn't left waiting for a round trip to be told no), and it
// pre-guesses each column's payroll field from its header text so a freshly-imported template starts mostly
// mapped rather than all "- skip -".
test("a bad template is rejected before upload, and a good one is pre-guessed and (if row 2 looks like instructions) offset", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const bankName = `E2E Parse Bank ${Date.now() % 100000}`;
  let dropBank = await withAllowedBank(page, bankName);

  // Re-added, not just re-checked, on a miss: `withAllowedBank` is etag-safe against another `editBanks`
  // caller, but a DIFFERENT settings panel's own Save (banks & currency, quick actions, letter defaults,
  // default department - each reads the WHOLE shared blob at ITS OWN page-mount and writes the whole thing
  // back, Settings.tsx's useOrgBlob, "single-admin last-write-wins is fine" by deliberate design) can still
  // land in between this add and this reload and silently take it back out - re-running the add is what
  // survives that.
  const bankButton = page.getByRole("button", { name: bankName }).first();
  await expect(async () => {
    await gotoRoute(page, "settings/bank-formats");
    await page.reload();
    if (!(await bankButton.count())) dropBank = await withAllowedBank(page, bankName);
    await expect(bankButton).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await bankButton.click();
  await expect(page.getByText("No template uploaded")).toBeVisible();
  const fileInput = page.locator('input[type="file"]').first();

  // Not a workbook at all - the magic-byte check on the first four bytes fails before the parser ever runs.
  await fileInput.setInputFiles({ name: "not-a-workbook.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("this is plainly not a spreadsheet") });
  // `.first()`: this error is announced twice, in the visible banner and in a screen-reader-only live region
  // with the same words (same reason "Could not read template" above needs it too).
  await expect(page.getByText("Could not read template").first()).toBeVisible();
  await expect(page.getByText("not an .xlsx file").first()).toBeVisible();
  await expect(page.getByText("No template uploaded")).toBeVisible(); // draft untouched

  // A real zip signature, but padded well past the 5 MB ceiling the server also enforces - rejected on size,
  // never handed to the (expensive) parser.
  const oversized = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(6 * 1024 * 1024)]);
  await fileInput.setInputFiles({ name: "too-big.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: oversized });
  await expect(page.getByText(/exceeds the 5 MB limit/).first()).toBeVisible(); // same double-announcement as above
  await expect(page.getByText("No template uploaded")).toBeVisible();

  // A real template, this time: headers whose text the client can guess from, and a second row that looks
  // like an instructions banner (two cells over 40 characters) - the way IDFC's own template ships.
  await fileInput.setInputFiles({
    name: "e2e-guessed.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: guessableWorkbook(),
  });
  await expect(page.getByText(/6 columns · sheet "Payments"/)).toBeVisible({ timeout: 30_000 });

  // Offset detected: data starts on row 3, not the plain default of 2.
  await expect(page.getByLabel("Data starts on row")).toHaveValue("3");

  // Each header pre-guessed to the field its own text names - nobody touched a dropdown yet.
  const rowSource = (i: number) => page.locator("tbody tr").nth(i).getByRole("combobox").first();
  await expect(rowSource(0)).toContainText("IFSC");
  await expect(rowSource(1)).toContainText("Account number");
  await expect(rowSource(2)).toContainText("Debit account (employer)");
  await expect(rowSource(3)).toContainText("Branch");
  await expect(rowSource(4)).toContainText("Transaction type");
  await expect(rowSource(5)).toContainText("Constant text"); // "Remarks" guesses to a literal, not skip

  await dropBank();
});

/**
 * Headers chosen to hit every branch of `guessSource` bar the ones `bankFormats.spec.ts` already exercises,
 * plus an instructions-style row 2 (two cells over 40 chars) so the data-start-row offset is also proven.
 */
function guessableWorkbook(): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["IFSC Code", "Account No", "Debit From", "Branch Name", "Payment Type", "Remarks"],
    [
      "Do not alter the column order or headings of this template - the bank's importer rejects any file that does.",
      "Leave this row exactly as provided; it is read by the bank's own parser and not by a human.",
      "", "", "", "",
    ],
    ["HDFC0000123", "000112223334", "", "Head Office", "NEFT", "Salary"],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Payments");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
