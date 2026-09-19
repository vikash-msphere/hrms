import { gotoRoute, purge, test, expect, withAllowedBank } from "./fixtures";

// Adding a person, and the person filling in their own bank details.
//
// Two browser-only things. First, a new hire is created from the directory with an employee ID the ORG
// FORMAT assigns - leave it blank and the server numbers them, which the field says rather than demanding a
// number nobody has yet. Second, bank details are self-service: the account number is stored encrypted and
// only ever shown masked, so the editor asks for it twice, blocks paste (pasting the same value twice is no
// check at all) and refuses to save on a mismatch. That double-entry check exists only in the form, and
// getting it wrong means salary paid into a mistyped account.
//
// The two halves are done by three different people on purpose: HR creates employees, but the seeded policy
// keeps everybody else's bank details out of HR's reach (`OWN_PII` in src/domain/grants.ts - PII stays
// self-service and super-only), so the account is captured by its owner - and the bank it names has to be on
// the org's list first, which only an admin sets.
test("HR adds an employee, and a person captures their own bank details", async ({ as }) => {
  test.setTimeout(180_000);
  const hr = await as("hr");
  const admin = await as("super");
  const employee = await as("employee");
  const stamp = Date.now();
  const last = `Hire${stamp % 100000}`;

  await gotoRoute(hr, "employees", "Directory");
  await hr.getByRole("button", { name: "Add employee" }).first().click();
  const form = hr.getByRole("dialog");
  await form.getByLabel("First name").fill("E2E");
  await form.getByLabel("Last name").fill(last);
  await form.getByLabel("Work email").fill(`e2e.hire.${stamp}@example.com`);
  await form.getByLabel("Job title").fill("E2E Tester");
  // Left blank on purpose: the org's own ID format numbers them, which is what the field promises.
  await expect(form.getByLabel("Employee ID")).toHaveValue("");
  await form.getByRole("button", { name: "Add employee", exact: true }).click();
  await expect(hr.getByRole("dialog")).toHaveCount(0);

  // On the directory, and their profile carries the ID the org assigned - not blank, and not typed in.
  await hr.getByPlaceholder("Search people…").fill(last);
  const row = hr.locator("tbody tr").filter({ hasText: last });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(hr.getByRole("heading", { level: 1, name: new RegExp(last) })).toBeVisible();
  // The header's facts band, where the assigned number is a labelled value (its copy affordance is a
  // hover icon named for the label, so the number itself is text rather than a button).
  await expect(hr.getByText(/^EMP-\d+$/)).toBeVisible();

  // A bank is picked from the org's list, not typed - so an admin puts one on the list. An empty list is a
  // dead end the panel has to name rather than showing an empty picker, and that is what the bank editor
  // says when nobody has configured one.
  // Put on the list over the wire, one line added and one line removed: the panel itself is `bankFormats`'s
  // subject, and the list is a SHARED org setting - a spec that saves a whole snapshot of it deletes whatever
  // another spec added in the meantime.
  const bankName = `E2E Trust Bank ${stamp % 100000}`;
  const dropBank = await withAllowedBank(admin, bankName);

  // Bank details, by their owner, on their own profile.
  await gotoRoute(employee, "profile"); // one record page, two addresses: its `h1` is the person's name
  await employee.getByRole("tab", { name: "Identity" }).click();
  // Scoped to the open tab: a profile carries several little "Add"/"Edit" pencils (bio, contact, personal),
  // and only the ones inside this panel belong to identity, bank and signature. `.last()` of them is the
  // bank card's: identity sits above it (and hides its own pencil when the org has configured no ID fields,
  // so counting from the front is not safe), and the signature card below has no pencil at all.
  const bankPanel = employee.getByRole("tabpanel");
  await bankPanel.getByRole("button", { name: /^(Add|Edit)$/ }).last().click();
  const bank = employee.getByRole("dialog");
  await expect(bank.getByRole("heading", { name: /bank details/i })).toBeVisible();
  await bank.getByLabel("Bank name").click();
  await employee.getByRole("option", { name: bankName }).click();
  await bank.getByLabel("IFSC / routing").fill("HDFC0001234");
  await bank.getByLabel("Account holder").fill("Eve Employee");
  await bank.getByLabel("Account number", { exact: true }).fill("000123456789");

  // The double-entry check. It is only asked for once the number is being set, because re-typing it to fix a
  // typo'd IFSC would be busywork.
  const save = bank.getByRole("button", { name: "Save", exact: true });
  await bank.getByLabel("Confirm account number").fill("000123456780");
  // Blurred on purpose: a field's message is held back until the reader has left it, so it doesn't shout at
  // somebody halfway through typing.
  await bank.getByLabel("Confirm account number").blur();
  await expect(bank.getByText("The two numbers don't match.")).toBeVisible();
  await expect(save).toBeDisabled();
  await bank.getByLabel("Confirm account number").fill("000123456789");
  await expect(bank.getByText("Matches.")).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(employee.getByRole("dialog")).toHaveCount(0);

  // Stored, and never shown in full again - the last four at most, which is the point of encrypting it.
  await expect(bankPanel.getByText(/6789/).first()).toBeVisible();
  await expect(employee.getByText("000123456789")).toHaveCount(0);

  // And an IFSC that is not an IFSC is refused before it can be saved. Currency matters here: the format is
  // only asserted for INR, the one scheme it can be asserted for.
  await bankPanel.getByRole("button", { name: /^(Add|Edit)$/ }).last().click();
  const again = employee.getByRole("dialog");
  await again.getByLabel("IFSC / routing").fill("NOPE");
  await again.getByLabel("IFSC / routing").blur();
  await expect(again.getByText(/Not an IFSC/)).toBeVisible();
  await expect(again.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await again.getByRole("button", { name: "Cancel" }).click();
  const discard = employee.getByRole("dialog");
  if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
    await discard.getByRole("button", { name: /Discard|Leave/ }).click();
  }
  await expect(employee.getByRole("dialog")).toHaveCount(0);

  // Take that one bank back off the org's list - it feeds every bank picker in the app.
  await dropBank();

  await purgeNamed(hr, last);
});

/** Drop the employee this spec created. */
async function purgeNamed(page: import("@playwright/test").Page, last: string) {
  const res = await page.request.get("/v1/employees?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) if (r.last_name === last) await purge(page, r.path!);
}
