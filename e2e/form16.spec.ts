import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";
import { extractPdfText } from "./pdfText";
import { fyLabels } from "../src/domain/incomeTax";

// Form 16: the one document an employer owes every employee, in two shapes.
//
// `src/routes/form16Generate.ts` builds the HRMS Part-B copy from a year of finalized payroll, and
// `src/routes/form16Upload.ts` takes the official TRACES PDF. The rule between them is precedence: once the
// official copy for a year is on file, the generated one is superseded - which is a fact about a SET of
// documents, computed while the list is rendered (EmployeeDocuments), and therefore invisible to any test
// that only looks at rows in a table.
//
// The rest of what this covers is the upload chain the server suite cannot reach: a picked File whose bytes
// are read and posted by the browser, refused before it is sent when it is not a PDF, and handed back as a
// file afterwards. The year-end batch is walked as far as its dialog - one call per employee, each notifying
// nobody but writing a document for everyone, is not something to set off on a shared database.
test.describe("Form 16", () => {
  test("the copy is generated, then the official one supersedes it", async ({ as }) => {
    test.setTimeout(240_000);
    // Super, not HR: the page is a person's own PII (`OWN_PII`), and the two Form 16 verbs are HR + super.
    const page = await as("super");
    const employee = await personPath(page, "employee");
    const id = employee.split("/")[1]!;
    // A year that is over, so this is not competing with whatever the current year's payroll has done - and
    // one this spec can leave clean afterwards.
    const fy = pastFy();
    await purgeForYear(page, employee, fy);

    await gotoRoute(page, `employees/${id}`);
    await page.getByRole("tab", { name: "Documents" }).click();

    // The HRMS copy, generated from the page: the verb builds a PDF from the year's finalized payroll AND
    // hands it over as a file in the same press, which is a chain only a browser completes.
    await page.getByRole("button", { name: "Generate Form 16" }).click();
    const gen = page.getByRole("dialog");
    await expect(gen.getByRole("heading", { name: "Generate Form 16 (Part B)" })).toBeVisible();
    await gen.getByLabel("Financial year").click();
    await page.getByRole("option", { name: `FY ${fy}` }).click();
    // The hand-over afterwards is best-effort by design (the button swallows a failed download because the
    // document is filed either way), so the toast - not a download event - is what says the verb ran.
    await gen.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(toast(page, "Form 16 generated")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // On its own, the generated copy is the one to file, and the list says so.
    await expect(page.getByText("HRMS-generated").first()).toBeVisible({ timeout: 30_000 });

    // The caption inside the PDF itself, not just the row's own metadata: FY and AY have to name the SAME
    // year pair (src/domain/incomeTax.ts's fyLabels is the one place both strings are built together, after
    // a real bug where the page captioned a projection for the wrong year). A byte-signature check would
    // never catch a caption naming the year before or after the one actually assembled.
    const generated = await generatedDoc(page, employee, fy);
    const generatedBytes = await page.request.post(`/v1/${generated.path}:download`, { headers: SPA_HEADERS });
    expect(generatedBytes.status(), await generatedBytes.text()).toBe(200);
    const generatedPdf = await generatedBytes.body();
    expect(generatedPdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const startYear = Number(fy.split("-")[0]);
    const { financialYear, assessmentYear } = fyLabels(startYear);
    const text = await extractPdfText(generatedPdf);
    expect(text).toContain(`Financial year ${financialYear}`);
    expect(text).toContain(`Assessment year ${assessmentYear}`);

    await page.getByRole("button", { name: "Upload official Form 16" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Upload official Form 16" })).toBeVisible();

    // The financial year is a FORMAT the server rejects when it is wrong ("FY25", "2025-2026"), which is why
    // the form picks from the years that exist rather than taking typing.
    await form.getByLabel("Financial year").click();
    await page.getByRole("option", { name: `FY ${fy}` }).click();

    // A refusal that happens before anything is sent: TRACES issues a PDF, so the field says so and the
    // submit stays shut with the reason on it.
    await form.locator('input[type="file"]').setInputFiles({
      name: "not-a-form16.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("this is not a PDF"),
    });
    await expect(form.getByText("Form 16 must be a PDF.").first()).toBeVisible();
    await expect(form.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();

    await form.locator('input[type="file"]').setInputFiles({
      name: `form16-${fy}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from(PDF, "latin1"),
    });
    await expect(form.getByText("Form 16 must be a PDF.")).toHaveCount(0);
    await form.getByRole("button", { name: "Upload", exact: true }).click();

    await expect(toast(page, "Official Form 16 uploaded")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Precedence, on the rendered list: the official copy is badged as the one to file, and the generated
    // copy for the SAME year is now marked superseded rather than quietly sitting there as an equal.
    await expect(page.getByText("Official · TRACES").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Superseded").first()).toBeVisible();
    await expect(page.getByText("HRMS-generated")).toHaveCount(0);

    // And the bytes made the whole trip: the File was read in the browser, posted and stored, and the row is
    // offered back with a way to fetch it. The bytes are read through the same POST-only `:download` method
    // the button uses (`documentUpload.spec.ts` owns the blob/`<a download>` half of that chain).
    const official = await officialDoc(page, employee, fy);
    // In the Documents card, not in the toast that is still on screen saying the same words.
    await expect(page.getByLabel("Documents").getByText(official.display_name)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Download/ }).first()).toBeVisible();
    const bytes = await page.request.post(`/v1/${official.path}:download`, { headers: SPA_HEADERS });
    expect(bytes.status(), await bytes.text()).toBe(200);
    expect((await bytes.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    await purgeForYear(page, employee, fy);
  });

  test("the year-end run counts the roster before it is set off", async ({ as }) => {
    const page = await as("super");

    await gotoRoute(page, "documents", "Documents");
    await page.getByRole("button", { name: "Year-end Form 16" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Form 16 for the year" })).toBeVisible();

    // The whole reason this dialog exists is the number on its button: one call per employee, so the count is
    // the size of the job, and it is stated before anybody presses it. The number itself is the page's own
    // roster, which is not the same read as `?page_size=200` - what matters is that both halves of the form
    // agree on one.
    await expect(form.getByText(/\d+ active employees?\./)).toBeVisible({ timeout: 30_000 });
    const said = (await form.getByText(/\d+ active employees?\./).innerText()).match(/(\d+) active/)![1]!;
    expect(Number(said)).toBeGreaterThan(0);
    await expect(form.getByRole("button", { name: `Generate ${said}` })).toBeEnabled();

    // Narrowed to nobody: the same button now refuses, with the reason rather than a silent no-op run.
    // The second picker on the form (the first is the financial year); the "Who" field holds a select and a
    // button side by side, so its label names the pair rather than one control.
    await form.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "Specific people…" }).click();
    await expect(form.getByText("0 selected")).toBeVisible();
    await expect(form.getByRole("button", { name: /^Generate/ })).toBeDisabled();
    await expect(form.getByText("Nobody is selected.")).toBeVisible();

    // Nothing is run: a year-end batch writes a document for every employee, which is not something to leave
    // behind on a shared database. Escape has proven unreliable at actually closing a dialog under load
    // elsewhere in this suite - retried rather than trusted to one press.
    await expect(async () => {
      if (!(await page.getByRole("dialog").count())) return;
      await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
      if (await discard.count()) await discard.click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
  });

  test("an ordinary employee is offered neither Form 16 action on their own record", async ({ as }) => {
    // The buttons are `personal-documents.write` (HR + super). Hide-never-disable means the person whose
    // Form 16 it is must not be offered the controls that file it - they read their copy, they do not issue it.
    const page = await as("employee");
    await gotoRoute(page, "profile", "My Profile");
    await page.getByRole("tab", { name: "Documents" }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload official Form 16" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Generate Form 16" })).toHaveCount(0);
  });
});

/** The financial year before the current one, in the `2025-26` shape the server insists on. */
function pastFy(): string {
  const now = new Date();
  // An Indian FY starts in April, so anything before April belongs to the year that started last April.
  const startYear = (now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1) - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Take out every Form 16 on file for this person and year.
 *
 * Both halves of the spec write a document, and a Form 16 is unique per person and year in practice - a
 * rerun that found last run's official copy already there would assert "superseded" against the wrong row.
 */
async function purgeForYear(page: import("@playwright/test").Page, employee: string, fy: string) {
  const res = await page.request.get("/v1/personal-documents?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as {
    results?: { path: string; employee?: string; financial_year?: string; document_type?: string }[];
  };
  for (const d of results) {
    if (d.employee === employee && d.financial_year === fy && d.document_type === "FORM16") await purge(page, d.path);
  }
}

/** The HRMS-generated (not official) Form 16 on file for this person and year. */
async function generatedDoc(
  page: import("@playwright/test").Page,
  employee: string,
  fy: string,
): Promise<{ path: string; display_name: string }> {
  const res = await page.request.get("/v1/personal-documents?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as {
    results?: { path: string; display_name: string; employee?: string; financial_year?: string; official?: boolean; document_type?: string }[];
  };
  const doc = results.find((d) => d.employee === employee && d.financial_year === fy && d.document_type === "FORM16" && !d.official);
  if (!doc) throw new Error(`e2e: no generated Form 16 on file for ${employee} in FY ${fy}`);
  return doc;
}

/** The official Form 16 on file for this person and year - the row the upload just made. */
async function officialDoc(
  page: import("@playwright/test").Page,
  employee: string,
  fy: string,
): Promise<{ path: string; display_name: string }> {
  const res = await page.request.get("/v1/personal-documents?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as {
    results?: { path: string; display_name: string; employee?: string; financial_year?: string; official?: boolean }[];
  };
  const doc = results.find((d) => d.employee === employee && d.financial_year === fy && d.official);
  if (!doc) throw new Error(`e2e: no official Form 16 on file for ${employee} in FY ${fy}`);
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
