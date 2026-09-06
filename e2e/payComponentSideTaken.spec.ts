import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// EPF and ESI keep exactly one component per side - a second employee-side EPF would double-charge every
// payslip. The server refuses it; the form is what stops a person from typing it in the first place, by
// showing the taken side as disabled and naming who already holds it, rather than letting the picker offer a
// choice the save will 400 on.
//
// The holder is brought by this spec. `bootstrap/collections/payComponents.ts` gives every real org a
// "Provident Fund" deduction on day one, but `scripts/seed.sql` - the database the dev and browser lanes run
// against - ships no pay components at all, so there is nothing here to take the side unless this puts it
// there. See the note in genSeed about the same divergence in the kudos catalog.
test("picking EPF offers the deduction side as already taken, naming the component that holds it", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const holder = `E2E provident fund ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/pay-components", {
    headers: SPA_HEADERS,
    data: { display_name: holder, kind: "deduction", method: "epf", rate: 12, recurring: true, in_ctc: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  const component = ((await made.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "settings/pay-components");
    // `.first()`: the toolbar button. An empty table offers the very same action again in its placeholder
    // (DataTable takes one `createBtn` for both `toolbar` and `emptyAction`).
    await page.getByRole("button", { name: "New component" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Method").click();
    await page.getByRole("option", { name: "EPF (Provident Fund)" }).click();

    // Picking EPF moves a fresh (earning-default) form onto the deduction side by itself - which is exactly
    // the side the component above already occupies, so the kind picker has to say so rather than let the
    // reader save into a component the server will refuse.
    await form.getByLabel("Kind").click();
    const deductionOption = page.getByRole("option", { name: /Deduction.*taken by/ });
    await expect(deductionOption).toBeVisible();
    await expect(deductionOption).toContainText(holder);
    await expect(deductionOption).toHaveAttribute("aria-disabled", "true");

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const discard = page.getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
  } finally {
    await purge(page, component);
  }
});
