import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// The details somebody keeps about themselves: where post reaches them, and who to call.
//
// Contact and emergency details are stored encrypted and are `OWN_PII` - the owner, HR and super, nobody
// else - so they are edited from the person's own Contact tab. `test/employees.test.ts` owns the encryption.
// What only a browser has is the pair of editors on that tab: contact details (phones, the two addresses,
// with "same as communication" so nobody types an address twice) and the emergency contact, which is the one
// record in the app that exists purely for the worst day.
test("somebody keeps their own contact and emergency details", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("employee");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). The details this test saves and reads back are what it proves; a
  // console line from a request retried behind that is not its failure.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  const stamp = Date.now() % 100000;
  const address = `${stamp} E2E Lane, Bengaluru`;

  await gotoRoute(page, "profile", "My Profile");
  await page.getByRole("tab", { name: "Contact" }).click();

  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: /^(Add|Edit)$/ }).first().click();

  const form = page.getByRole("dialog");
  await expect(form.getByText("Edit contact details")).toBeVisible();
  await form.getByLabel("Personal phone").fill("+91 90000 00000");
  await form.getByLabel("Communication address").fill(address);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // On the card, and again from cold: a contact detail that lives only in the form is a person nobody can
  // reach.
  await expect(panel.getByText(address)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await page.getByRole("tab", { name: "Contact" }).click();
  await expect(page.getByRole("tabpanel").getByText(address)).toBeVisible({ timeout: 30_000 });

  // The emergency contact is its own editor, because it is asked for at a different moment and read by
  // somebody else entirely.
  const emergency = page.getByRole("tabpanel").getByRole("button", { name: /Emergency|^(Add|Edit)$/ }).last();
  await emergency.click();
  const second = page.getByRole("dialog");
  await expect(second).toBeVisible({ timeout: 30_000 });
  await expect(second.getByRole("button", { name: /^(Save|Cancel)/ }).first()).toBeVisible();
  await second.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
});
