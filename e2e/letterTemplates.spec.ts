import { gotoRoute, test, expect } from "./fixtures";

// The letter template editor - where the 20 stock letters come from, and where an org writes its own.
//
// `test/letters.test.ts` renders a template server-side and `letterPdf.spec.ts` proves a generated letter
// reaches disk. Neither touches the authoring side, which is entirely a browser: a new letter type, a stack
// of content blocks, HR-entered inputs, and a preview that renders the UNSAVED draft against a real employee
// so the author sees the letter before anybody is issued one. A template editor that quietly drops the block
// you just wrote produces a wrong letter on company paper, which is not a thing that can be recalled.
test("a letter type is written, previewed against an employee, and removed", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const label = `E2E Letter ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/letters");
  await expect(page.locator("h1").first()).toHaveText("Letter templates");

  // A new type is added by naming it - and until it is named there is nothing to add, which the disabled
  // button says.
  const add = page.locator("#letter-type-list").getByRole("button").last();
  await expect(add).toBeDisabled();
  await page.getByPlaceholder("New letter type…").fill(label);
  await add.click();

  // The new type is selected, and the editor is its own: label, category and the filename it downloads as.
  // The selection follows the CREATE, not the press - until the row comes back the editor is still showing
  // whichever type was open before - so this waits rather than reads.
  await expect(page.getByLabel("Label")).toHaveValue(label, { timeout: 30_000 });
  await page.getByLabel("Category").fill("E2E");
  await page.getByLabel("Download filename").fill("e2e-letter-{{employee.first_name}}");

  // Content is a stack of blocks. A subject and a paragraph is the smallest letter that is a letter, and the
  // paragraph carries a placeholder, which is the whole point of a template.
  const blocks = page.getByRole("tabpanel");
  await addBlock(page, "Subject");
  await blocks.getByRole("textbox").last().fill("Your E2E letter");
  await addBlock(page, "Paragraph");
  await blocks.getByRole("textbox").last().fill("Dear {{employee.first_name}}, this letter was written by the e2e suite.");

  // And a value HR types at generation time, which is what separates a template from a fixed document.
  await page.getByRole("tab", { name: "Input fields" }).click();
  await page.getByRole("button", { name: "Add input field" }).click();
  const inputs = page.getByRole("tabpanel");
  await inputs.getByPlaceholder("key").fill("reason");
  await inputs.getByPlaceholder("Label").fill("Reason");

  const save = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();

  // The preview renders the draft as a real PDF, for a real employee - the only way to see the letter before
  // issuing one at somebody.
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByLabel("Sample employee").click();
  await page.getByRole("option").first().click();
  await page.getByRole("button", { name: /^Preview/ }).click();
  const frame = page.getByTitle("Letter preview");
  await expect(frame).toBeVisible({ timeout: 60_000 });
  await expect(frame).toHaveAttribute("src", /^blob:/);

  // Read back from cold: templates are org config, so the blocks have to come back from the server.
  await page.reload();
  await expect(page.locator("h1").first()).toHaveText("Letter templates");
  await page.getByRole("button", { name: label }).click();
  await expect(page.getByLabel("Download filename")).toHaveValue("e2e-letter-{{employee.first_name}}");
  await expect(page.getByText("Your E2E letter")).toBeVisible();

  // Deleting a letter type is destructive - existing letters were issued from it - so it asks first.
  await page.getByRole("button", { name: /^Delete/ }).first().click();
  const confirmDialog = page.getByRole("dialog");
  await expect(confirmDialog.getByText(`Delete "${label}"?`)).toBeVisible();
  await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name: label })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: label })).toHaveCount(0, { timeout: 30_000 });
});

/** Add a content block of the given kind to the open template. */
async function addBlock(page: import("@playwright/test").Page, kind: string) {
  await page.getByRole("tabpanel").getByRole("combobox").last().click();
  await page.getByRole("option", { name: kind, exact: true }).click();
}
