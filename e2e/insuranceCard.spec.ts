import { gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";

// The health-insurance e-card: a personal document typed INSURANCE, filed from the Documents tab beside the
// other document actions.
//
// It used to hang off the Emergency card on the Profile tab, with an upload button gated on who may edit the
// emergency CONTACT - a different collection's grant entirely, so the button was offered to the one person
// (the owner) whose personal-documents grant is read-only and whose press could only ever 403. What this
// covers is the pair that replaced it: HR files the card from the Documents tab and it lands in the list, and
// the owner is not offered the control at all.
test.describe("insurance e-card", () => {
  test("HR files the card from the Documents tab and it lands in their documents", async ({ as }) => {
    test.setTimeout(240_000);
    const page = await as("super");
    const employee = await personPath(page, "employee");
    const id = employee.split("/")[1]!;
    const name = `E2E Insurance ${Date.now() % 100000}`;

    await gotoRoute(page, `employees/${id}`);
    await page.getByRole("tab", { name: "Documents" }).click();

    await page.getByRole("button", { name: "Upload insurance card" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Upload insurance card" })).toBeVisible();
    // Nothing attached yet, so the submit stays shut with the reason on it rather than posting an empty row.
    await expect(form.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();

    await form.locator('input[type="file"]').setInputFiles({
      name: "insurance.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(PDF, "latin1"),
    });
    await form.getByLabel("Name").fill(name);
    await form.getByRole("button", { name: "Upload", exact: true }).click();

    await expect(toast(page, "Insurance card uploaded")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    // In the list, not only in the toast still saying the same words: the create and the bytes are two calls,
    // and a row that never arrived is exactly what a toast fired between them would hide.
    await expect(page.getByLabel("Documents").getByText(name)).toBeVisible({ timeout: 30_000 });

    const filed = await insuranceDoc(page, employee, name);
    await purge(page, filed.path);
  });

  test("the owner is not offered the control on their own record", async ({ as }) => {
    // An ordinary employee holds `personal-documents` READ (src/domain/grants.ts) - they read their documents,
    // they do not file them - so hide-never-disable says the button is absent rather than greyed out or 403ing
    // on press. An org that wants self-service files a GRANT for it; it is policy data, not a branch here.
    const page = await as("employee");
    await gotoRoute(page, "profile");
    await page.getByRole("tab", { name: "Documents" }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload insurance card" })).toHaveCount(0);
  });
});

/** The INSURANCE document this spec just filed, by the name it gave it. */
async function insuranceDoc(
  page: import("@playwright/test").Page,
  employee: string,
  name: string,
): Promise<{ path: string }> {
  const res = await page.request.get("/v1/personal-documents?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as {
    results?: { path: string; display_name: string; employee?: string; document_type?: string }[];
  };
  const doc = results.find((d) => d.employee === employee && d.document_type === "INSURANCE" && d.display_name === name);
  if (!doc) throw new Error(`e2e: no insurance card named "${name}" on file for ${employee}`);
  return doc;
}

// The smallest thing a PDF reader will open: one empty page, carried by the spec rather than read from disk.
const PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");
