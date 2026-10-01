import * as XLSX from "xlsx";
import { gotoRoute, landedResponse, withAllowedBank, test, expect } from "./fixtures";

// The bank payout format editor - where an org says how its bank wants a bulk-payment file.
//
// `test/bankFormats.test.ts` owns the export the mapping produces. Three things live only here. The panel is
// gated on the org's bank list: with no banks there is no format to define. The bank's blank template is READ
// IN THE BROWSER - an .xlsx is parsed client-side into a column list, and if that parse breaks there is
// nothing to map and no server test notices. And the employer's own debit account is captured here and stored
// encrypted, so it reads back masked; a panel that echoed it in full would leak the account every salary
// payment is drawn from.
test("a bank template is read in, its columns mapped, and the debit account reads back masked", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const bankName = `E2E Payout Bank ${Date.now() % 100000}`;

  // With no banks configured the panel is a dead end, and it names the way out rather than showing an empty
  // picker.
  await gotoRoute(page, "settings/bank-formats");
  await expect(page.locator("h1").first()).toHaveText("Bank payout formats");
  if (await page.getByText("No banks yet").count()) {
    await expect(page.getByText(/Add your allowed banks/)).toBeVisible();
  }

  // So: put one on the list, which is the org setting this panel reads. Added as ONE line through the
  // helper rather than by retyping the box: the list is a shared org setting, and a spec that writes back the
  // whole textarea deletes whatever a spec running beside it added between the read and the save. What the
  // banks panel itself does with typing is `settingsPanels.spec.ts`'s subject, not this one's.
  let dropBank = await withAllowedBank(page, bankName);

  // The new bank is now offered, and picking it opens its (empty) format. Read from cold first: this browser
  // is holding the settings snapshot it took when the page loaded (web/src/lib/settingsStore.ts), and the
  // bank was added over the wire, so a reload is what puts it in front of the reader. Re-added, not just
  // re-checked, on a miss: `withAllowedBank` itself is etag-safe against another `editBanks` caller, but a
  // DIFFERENT settings panel's own Save (banks & currency, quick actions, letter defaults, default
  // department - each reads the WHOLE shared blob at ITS OWN page-mount and writes the whole thing back,
  // Settings.tsx's useOrgBlob, "single-admin last-write-wins is fine" by deliberate design) can still land in
  // between this add and this reload and silently take it back out - re-running the add is what survives that.
  const bankButton = page.getByRole("button", { name: bankName }).first();
  await expect(async () => {
    await gotoRoute(page, "settings/bank-formats");
    await page.reload();
    if (!(await bankButton.count())) dropBank = await withAllowedBank(page, bankName);
    await expect(bankButton).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await bankButton.click();
  await expect(page.getByText("No template uploaded")).toBeVisible();
  // Nothing to map until a template arrives, so the mapping table isn't there to be filled in wrongly.
  await expect(page.getByLabel("Header row")).toHaveCount(0);

  // The bank's blank template, parsed in the browser: three headers on row 1, so the export writes from row 2.
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "e2e-bulk-payment.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: templateWorkbook(),
  });
  await expect(page.getByText(/3 columns · sheet "Payments"/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("e2e-bulk-payment.xlsx")).toBeVisible();

  // Each header of the bank's own file is now a row to map. The headers came from the file, not from us -
  // that is what the parse is for.
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(page.getByText("Beneficiary")).toBeVisible();

  await page.getByLabel("Header row").fill("1");
  await page.getByLabel("Data starts on row").fill("2");
  await mapColumn(page, 0, "Beneficiary name");
  await mapColumn(page, 1, "Account number");
  await mapColumn(page, 2, "Net pay (amount)");
  await page.getByLabel("Debit account number").fill("998877665544");
  // The reload has to come after the WRITE, not after the press: a reload that overtakes the in-flight save
  // reads the settings row as it was before it, and "the mapping did not survive" would be a lie about a
  // save that never happened.
  // Save is two writes in turn - the mapping, then (for a super) the debit account - so the reload waits on
  // BOTH: one taken on the first answer aborted the second before it was sent, and the mask never existed.
  const saved = landedResponse(page, (r) => /\/v1\/bank-formats\//.test(r.url()) && r.request().method() === "PATCH", 60_000);
  const debitSaved = landedResponse(page, (r) => /\/v1\/payroll-debit-accounts\//.test(r.url()) && r.request().method() === "PATCH", 60_000);
  await page.getByRole("button", { name: `Save ${bankName} format` }).click();
  expect((await saved).ok(), "the bank format was not saved").toBe(true);
  expect((await debitSaved).ok(), "the debit account was not saved").toBe(true);

  // Read back from cold: the mapping survived, and the debit account comes back as a mask - never as the
  // digits that were typed. Re-added on a miss same as the first reload above: the bank NAME can be clobbered
  // back out of the allow-list by another settings panel's Save in this window too, and re-adding it does not
  // lose the format mapping already saved under it (a separate row, keyed by the bank).
  await expect(async () => {
    await page.reload();
    if (!(await bankButton.count())) dropBank = await withAllowedBank(page, bankName);
    await expect(bankButton).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await bankButton.click();
  await expect(page.getByText(/3 columns · sheet "Payments"/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Data starts on row")).toHaveValue("2");
  await expect(page.locator("tbody tr").first()).toContainText("Beneficiary name");
  await expect(page.getByLabel("Debit account number")).toHaveValue("");
  await expect(page.getByLabel("Debit account number")).toHaveAttribute("placeholder", /5544/);
  await expect(page.getByText("998877665544")).toHaveCount(0);

  // Take THIS bank back off the list - one line removed, not a snapshot restored, for the same reason it was
  // added that way.
  await dropBank();
  await gotoRoute(page, "settings/bank-formats");
  await page.reload(); // again from cold, for the snapshot this browser is holding
  await expect(page.getByRole("button", { name: bankName })).toHaveCount(0, { timeout: 30_000 });
});

/** A bank's blank bulk-payment sheet: headers only, which is what one of these files actually is. */
function templateWorkbook(): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([["Beneficiary", "Credit A/C No", "Amount"]]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Payments");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Point one of the template's columns at a payroll field. */
async function mapColumn(page: import("@playwright/test").Page, index: number, source: string) {
  await page.locator("tbody tr").nth(index).getByRole("combobox").first().click();
  await page.getByRole("option", { name: source, exact: true }).click();
}
