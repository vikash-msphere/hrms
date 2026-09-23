import { SPA_HEADERS, gotoRoute, patchOrgSettings, personPath, purge, test, expect, toast } from "./fixtures";
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
    const employee = await personPath(page, "employee");
    // Retried as one whole unit, generated letter included: this panel's Save reads the WHOLE
    // settings/organization blob at page-mount and writes the whole thing back (Settings.tsx's useOrgBlob -
    // "single-admin last-write-wins is fine", a deliberate call for production's single-admin reality, not
    // for this suite's many settings-panel specs running at once). That race is not only between this Save
    // and the form's own reload - a concurrent Save from another panel (banks, quick actions, default
    // department) can land in the narrower window between this test's own successful reload and the
    // generateLetter call right after it, stamping the letter with whatever signatory was there before this
    // test touched it even though the FORM was showing the right one a moment earlier. Redone from a fresh
    // mount (and a fresh letter) whenever any step downstream of the save doesn't confirm it.
    await expect(async () => {
      await gotoRoute(page, "settings/letter-defaults", "Letter defaults");
      await page.getByRole("tab", { name: "Signatory" }).click();
      await page.getByLabel("Signatory name").fill(signatoryName);
      await page.getByLabel("Signatory title").fill(signatoryTitle);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Letter defaults saved")).toBeVisible({ timeout: 30_000 });

      await page.reload();
      await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: "Signatory" }).click();
      await expect(page.getByLabel("Signatory name")).toHaveValue(signatoryName, { timeout: 5_000 });
      await expect(page.getByLabel("Signatory title")).toHaveValue(signatoryTitle, { timeout: 5_000 });

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
      if (!text.includes(signatoryName) || !text.includes(signatoryTitle)) {
        await purge(page, doc.path); // a stale-signatory letter, not proof of anything - dropped before retrying
        docPath = undefined;
      }
      expect(text).toContain(signatoryName);
      expect(text).toContain(signatoryTitle);
    }).toPass({ timeout: 120_000 });
  } finally {
    if (docPath) await purge(page, docPath);
    await purge(page, template.path);
    // Only the two fields this spec itself set, inside letter_defaults, merged onto the row as it looks NOW -
    // not a snapshot from before this test's own Save (definitely stale by cleanup time), which would take
    // back out whatever another settings-panel spec wrote to a different key of this same shared blob.
    await patchOrgSettings(page, (blob) => {
      const ld = { ...((blob.letter_defaults as Record<string, unknown> | undefined) ?? {}) };
      delete ld.signatory_name;
      delete ld.signatory_title;
      return { ...blob, letter_defaults: ld };
    });
  }
});
