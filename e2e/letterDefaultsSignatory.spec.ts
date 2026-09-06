import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";
import { extractPdfText } from "./pdfText";

// Letter defaults (Settings -> Letters -> Letter defaults): the signatory name/title stamped onto every
// generated letter's signature block. Never touched by any spec - `settingsPanels.spec.ts`'s generic sweep
// deliberately covers only the panels with a plain toggle to round-trip, and this one has none. Proven all
// the way through: the form saves and survives a reload, and a template with a `signature` block actually
// bakes the saved name and title into the letter it generates, not just into the settings blob.
test("the signatory name and title are saved and stamped onto a generated letter's signature block", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const signatoryName = `E2E Signatory ${stamp}`;
  const signatoryTitle = `E2E Title ${stamp}`;

  const before = await page.request.get("/v1/settings/organization");
  const previous = before.ok() ? ((await before.json()) as { value?: Record<string, unknown> }).value ?? {} : {};

  const madeTemplate = await page.request.post("/v1/letter-templates", {
    headers: SPA_HEADERS,
    data: {
      label: `E2E signatory template ${stamp}`,
      blocks: [
        { kind: "subject", text: `Subject: E2E signatory ${stamp}` },
        { kind: "para", text: "Dear {{employee.first_name}}, this letter tests the signature block." },
        { kind: "signature" },
      ],
    },
  });
  expect(madeTemplate.status(), await madeTemplate.text()).toBe(200);
  const template = (await madeTemplate.json()) as { path: string };

  let docPath: string | undefined;
  try {
    await gotoRoute(page, "settings/letter-defaults", "Letter defaults");
    await page.getByRole("tab", { name: "Signatory" }).click();
    await page.getByLabel("Signatory name").fill(signatoryName);
    await page.getByLabel("Signatory title").fill(signatoryTitle);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Letter defaults saved")).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Signatory" }).click();
    await expect(page.getByLabel("Signatory name")).toHaveValue(signatoryName, { timeout: 30_000 });
    await expect(page.getByLabel("Signatory title")).toHaveValue(signatoryTitle);

    const employee = await personPath(page, "employee");
    const madeDoc = await page.request.post("/v1/personal-documents:generateLetter", {
      headers: SPA_HEADERS,
      data: { employee, letter_type: template.path },
    });
    expect(madeDoc.status(), await madeDoc.text()).toBe(200);
    const doc = (await madeDoc.json()) as { path: string };
    docPath = doc.path;

    const downloaded = await page.request.post(`/v1/${doc.path}:download`, { headers: SPA_HEADERS });
    expect(downloaded.status(), await downloaded.text()).toBe(200);
    const bytes = await downloaded.body();
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = await extractPdfText(bytes);
    expect(text).toContain(signatoryName);
    expect(text).toContain(signatoryTitle);
  } finally {
    if (docPath) await purge(page, docPath);
    await purge(page, template.path);
    await page.request.patch("/v1/settings/organization", { headers: SPA_HEADERS, data: { value: previous } });
  }
});
