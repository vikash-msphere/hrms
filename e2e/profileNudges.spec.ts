import { SPA_HEADERS, allowConsoleErrors, gotoRoute, personId, test, expect } from "./fixtures";

// The completeness meter, and the one record that exists for the worst day.
//
// The meter is the only nudge in the app: the server computes which sections of a person's record are still
// empty (`profile_completeness` rides the employee row - no extra request), and the page turns each missing
// one into a chip that JUMPS to where it is filled in. That jump is pure browser - a chip switches a tab, or
// opens a dialog - and so is the thing it is for: filling the section in has to make the chip go away without
// a reload, or the nudge is a list that never shrinks.
//
// `personalDetails.spec.ts` reaches the emergency card from the Profile tab directly. This drives the OTHER
// way in (the nudge chip) and the half-filled warning that is the mistake people actually make - a name with
// no number.
test("a missing section is nudged, jumped to, filled in, and the nudge goes away", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("employee");
  // The 409 the save below retries through is a REFUSAL the app is supposed to make, but the browser logs
  // every non-2xx fetch as a console error regardless, so answering the conflict correctly still failed the
  // console fixture. Matched on the status because the tolerance patterns are tested against the console
  // message alone (fixtures.ts) and a failed-resource message names no url.
  allowConsoleErrors(page, /status of 409 \(Conflict\)/);
  const id = await personId(page, "employee");
  const stamp = Date.now() % 100000;
  const contact = `E2E Kin ${stamp}`;

  // The nudge only exists while the section is empty, and a previous run filled it in - so this spec sets up
  // the state it is about, keeping every other field of the record as it found it.
  await clearEmergency(page, id);

  await gotoRoute(page, "profile"); // one record page, two addresses: its `h1` is the person's name
  // The meter is a real progressbar with the score on it, not a decorative bar.
  const meter = page.getByRole("progressbar", { name: "Profile completeness" });
  // Read from cold if the first paint arrived without it: the meter rides the employee record the page
  // fetched, so a page that came up while that read was still in flight has nothing to draw - and this spec
  // has just made the record incomplete, so "no meter" is a stale page rather than a finished profile.
  await expect(async () => {
    if (!(await meter.count())) await page.reload();
    await expect(meter).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 90_000 });
  await expect(page.getByText("Finish your profile")).toBeVisible();
  const scored = Number((await meter.getAttribute("aria-valuenow")) ?? "-1");
  expect(scored).toBeGreaterThanOrEqual(0);

  // The chip for the section that is empty, which is the one this spec emptied.
  const chip = page.getByRole("button", { name: "Emergency contact" });
  await expect(chip).toBeVisible();
  await chip.click();

  // The jump: the chip lands on the Profile tab, where the Emergency card is - a nudge that only scrolled you
  // near the right place would be a nudge nobody follows. The card reads the section back empty, which is the
  // state this spec set up.
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("Emergency contact name")).toBeVisible({ timeout: 30_000 });

  // `.nth(2)`: three cards on this tab carry the same unlabelled pencil - Personal, Contact, Emergency, in
  // that order. The dialog's own title is asserted below, so a card that moves takes the spec with it. Each
  // pencil appears only once its card has loaded, so all three are waited for before one is picked by place.
  const pencils = panel.getByRole("button", { name: /^(Add|Edit)$/ });
  await expect(pencils).toHaveCount(3, { timeout: 30_000 });
  await pencils.nth(2).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Edit emergency details")).toBeVisible({ timeout: 30_000 });
  // Half filled is the mistake worth catching: a contact needs both halves to be worth calling, and the form
  // says so while it is still being typed rather than saving something useless.
  await dialog.getByLabel("Name").first().fill(contact);
  await expect(dialog.getByText("A contact needs both a name and a number to be worth calling.")).toBeVisible();
  await dialog.getByLabel("Phone").first().fill("+91 90000 00001");
  await expect(dialog.getByText("A contact needs both a name and a number to be worth calling.")).toHaveCount(0);
  await dialog.getByLabel("Relation").first().fill("Spouse");

  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  // No assertion on the toast: it lives for a few seconds, and a browser sharing a machine with fifteen
  // others can be looking the other way for longer than that. The card below is the better evidence that the
  // save landed - it is the contact itself, come back from the server.
  //
  // Retried through the CONFLICT, because this save is a compare-and-swap over the whole personal-info blob
  // and the specs sharing this employee write that same row. Losing that race is the app being right: the
  // dialog stays open with what was typed still in it, re-reads the record and says "check them and save
  // again" - so this does what the message asks. Left alone it read as a 30s hang, because the card correctly
  // never updated and this spec deliberately asserts no toast (see above), so the one thing that said what
  // happened went unwatched.
  const conflict = dialog.getByText(/Somebody else changed these details/);
  await expect(async () => {
    if (await conflict.count()) await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText(contact)).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(panel.getByText("Spouse")).toBeVisible();

  // And the nudge moved, without a reload: saving re-reads the employee row the flags ride on. The tile for
  // the section that was just filled stays on the checklist and flips to "Added" - a checklist that deletes
  // what you finish makes it impossible to see that you are nearly done - so what proves the save landed is
  // the tile's own state and the score, not the tile disappearing.
  await expect(page.getByRole("button", { name: "Emergency contact" }).getByText("Added")).toBeVisible({ timeout: 30_000 });
  const after = page.getByRole("progressbar", { name: "Profile completeness" });
  if (await after.count()) {
    expect(Number((await after.getAttribute("aria-valuenow")) ?? "-1")).toBeGreaterThan(scored);
  } else {
    // Nothing left to nudge about: the meter hides itself rather than sitting at 100%, which is the other
    // correct answer here.
    await expect(page.getByText("Finish your profile")).toHaveCount(0);
  }
});

/**
 * Empty the emergency contact, and nothing else.
 *
 * Only the three fields this spec is about are named: the sub-resource is a merge patch, so what is not
 * mentioned is left as it was. Reading the record first and writing it back whole - which this used to do -
 * is what quietly wiped the address `personalDetails.spec.ts` was saving on the same person a moment later.
 */
async function clearEmergency(page: import("@playwright/test").Page, id: string) {
  const wrote = await page.request.patch(`/v1/employees/${id}/personal-info`, {
    headers: SPA_HEADERS,
    data: { emergency_name: "", emergency_phone: "", emergency_relation: "" },
  });
  expect(wrote.status(), await wrote.text()).toBe(200);
}
