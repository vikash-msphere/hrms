import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// The downstream half of a letterhead's print version: once a letter type is issued on one, the generated
// document itself offers a SECOND download - re-rendered on the print page rather than the screen one -
// and that menu item exists at all only because this specific letterhead has one. Nothing in the suite
// reaches this: `letterheadPrintVersion.spec.ts` only builds the print version in the designer, and every
// letter-generation spec uses a template with no letterhead override at all.
test("a letter issued on a print-enabled letterhead offers a print download of its own", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now();
  const letterheadLabel = `E2E print letterhead ${stamp}`;
  const templateLabel = `E2E print template ${stamp}`;
  const subjectLine = `E2E print variant ${stamp}`;

  const madeLetterhead = await page.request.post("/v1/letterheads", {
    headers: SPA_HEADERS,
    data: { label: letterheadLabel, design: null, print_design: {} },
  });
  expect(madeLetterhead.status(), await madeLetterhead.text()).toBe(200);
  const letterhead = (await madeLetterhead.json()) as { path: string };

  const madeTemplate = await page.request.post("/v1/letter-templates", {
    headers: SPA_HEADERS,
    data: {
      label: templateLabel,
      letterhead: letterhead.path,
      blocks: [
        { kind: "subject", text: `Subject: ${subjectLine}` },
        { kind: "para", text: "Dear {{employee.first_name}}, this is the print-download spec." },
      ],
    },
  });
  expect(madeTemplate.status(), await madeTemplate.text()).toBe(200);
  const template = (await madeTemplate.json()) as { path: string };

  let docPath: string | undefined;
  try {
    const employee = await personPath(page, "employee");
    const madeDoc = await page.request.post("/v1/personal-documents:generateLetter", {
      headers: SPA_HEADERS,
      data: { employee, letter_type: template.path },
    });
    expect(madeDoc.status(), await madeDoc.text()).toBe(200);
    const doc = (await madeDoc.json()) as { path: string };
    docPath = doc.path;

    await gotoRoute(page, "documents", "Documents");
    // Named "<letter type> - <person>", not by anything in the body - the subject line lives in the PDF, not
    // the row.
    const row = page.locator("tbody tr").filter({ hasText: templateLabel }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();

    // Only a letterhead with its own print version earns this second menu item.
    await expect(page.getByRole("menuitem", { name: "Download (print)" })).toBeVisible({ timeout: 15_000 });
    const [printed] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: "Download (print)" }).click(),
    ]);
    expect(printed.suggestedFilename()).toMatch(/\.pdf$/);
    const path = await printed.path();
    if (!path) throw new Error("the print download produced no file");
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  } finally {
    if (docPath) await purge(page, docPath);
    await purge(page, template.path);
    await purge(page, letterhead.path);
  }
});
