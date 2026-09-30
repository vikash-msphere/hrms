import type { Locator } from "@playwright/test";
import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// The details somebody keeps about themselves: where post reaches them, and who to call.
//
// Contact and emergency details are stored encrypted and are `OWN_PII` - the owner, HR and super, nobody
// else - so they are edited from the person's own Profile tab. `test/employees.test.ts` owns the encryption.
// What only a browser has is the pair of editors: contact details (phones, the two addresses, with "same as
// communication" so nobody types an address twice), and the emergency contact under it - the one record in the
// app that exists purely for the worst day. Both are cards on that tab.
test("somebody keeps their own contact and emergency details", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("employee");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). The details this test saves and reads back are what it proves; a
  // console line from a request retried behind that is not its failure.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  // The 409 `saveThroughConflict` answers is a refusal the app is supposed to make, but the browser logs every
  // non-2xx fetch as a console error regardless.
  allowConsoleErrors(page, /status of 409 \(Conflict\)/);
  const stamp = Date.now() % 100000;
  const address = `${stamp} E2E Lane, Bengaluru`;

  await gotoRoute(page, "profile"); // one record page, two addresses: its `h1` is the person's name
  await page.getByRole("tab", { name: "Profile", exact: true }).click();

  const panel = page.getByRole("tabpanel");
  // `.nth(1)`: the Profile tab carries three cards with the same unlabelled pencil - Personal, Contact,
  // Emergency, in that order - and this half wants the second. The dialog's own title is asserted below, so a
  // pencil that moves takes the spec with it rather than silently editing the wrong card. Each pencil appears
  // only once its card has loaded, so all three are waited for before one is picked by place.
  const pencils = panel.getByRole("button", { name: /^(Add|Edit)$/ });
  await expect(pencils).toHaveCount(3, { timeout: 30_000 });
  await pencils.nth(1).click();

  const form = page.getByRole("dialog");
  await expect(form.getByText("Edit contact details")).toBeVisible();
  await form.getByLabel("Personal phone").fill("+91 90000 00000");
  await form.getByLabel("Communication address").fill(address);
  await saveThroughConflict(form, panel.getByText(address));
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // On the card, and again from cold: a contact detail that lives only in the form is a person nobody can
  // reach.
  await expect(panel.getByText(address)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("tabpanel").getByText(address)).toBeVisible({ timeout: 30_000 });

  // The emergency contact is its own editor, because it is asked for at a different moment and read by
  // somebody else entirely - but it is read from the same encrypted blob and filled in the same sitting, so it
  // is the third card on this tab rather than a button in the page header.
  const contact = `E2E Kin ${stamp}`;
  await expect(pencils).toHaveCount(3, { timeout: 30_000 });
  await pencils.nth(2).click();
  const second = page.getByRole("dialog");
  await expect(second.getByText("Edit emergency details")).toBeVisible({ timeout: 30_000 });
  // `.first()`: the form carries a second contact with the same three labels under the first.
  await second.getByLabel("Name").first().fill(contact);
  await second.getByLabel("Phone").first().fill("+91 90000 00002");
  await saveThroughConflict(second, panel.getByText(contact));
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(panel.getByText(contact)).toBeVisible({ timeout: 30_000 });
});

/**
 * Save, and save again through the CONFLICT. Both editors are a compare-and-swap over the whole personal-info
 * blob, and `profileNudges.spec.ts` writes the emergency contact on this same seeded person at the same time.
 * Losing that race is the app being right: the dialog stays open with what was typed still in it, re-reads the
 * record and says "check them and save again" - so this does what the message asks, the way profileNudges does.
 */
async function saveThroughConflict(dialog: Locator, saved: Locator) {
  const conflict = dialog.getByText(/Somebody else changed these details/);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(async () => {
    if (await conflict.count()) await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(saved).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
}
