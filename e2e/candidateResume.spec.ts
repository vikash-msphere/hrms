import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The CV, attached and read back.
//
// A candidate with nothing to screen stalls in the pool, so the resume is the one attachment the hiring flow
// really turns on - and it is a file, which means the browser owns both ends of it: a picker that posts the
// bytes as an octet-stream, and a download that comes back through the blob chain rather than as a URL
// anybody could fetch. The row's affordance also has to change once there is something on file ("Attach"
// becomes "Replace"), because attaching a second CV over a first is a decision, not an accident.
//
// `documentUpload` covers the same chain for documents and `test/ats.test.ts` owns the storage. What only a
// browser shows is this one: the pick, the row changing what it offers, and the bytes coming back.
test("a resume is attached to a candidate and comes back as a file", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const admin = await as("super"); // the hard purge is an admin's to make
  const stamp = Date.now() % 1_000_000;
  const name = `E2E Resume ${stamp}`;

  const created = await page.request.post("/v1/candidates", {
    headers: SPA_HEADERS,
    data: { name, email: `e2e.resume.${stamp}@example.com` },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "candidates", "Candidates");
    const row = page.locator("tbody tr").filter({ hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Nothing on file yet: the row offers the attachment and nothing to read.
    await expect(row.getByRole("button", { name: "Attach" })).toBeVisible();
    await expect(row.getByRole("button", { name: "View" })).toHaveCount(0);

    // The picker is a hidden input the button opens, which is what `setInputFiles` drives.
    const chooser = page.waitForEvent("filechooser");
    await row.getByRole("button", { name: "Attach" }).click();
    await (await chooser).setFiles({
      name: "resume.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(MINIMAL_PDF, "utf8"),
    });

    // On file: the server says so, and the row now offers to read it and to replace it rather than to attach.
    await expect.poll(() => hasResume(page, path), { timeout: 30_000 }).toBe(true);
    await expect(row.getByRole("button", { name: "View" })).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole("button", { name: "Replace" })).toBeVisible();

    // And the bytes come back: a resume that uploads but cannot be read is a candidate nobody can screen.
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      row.getByRole("button", { name: "View" }).click(),
    ]);
    const saved = await file.path();
    if (!saved) throw new Error("the download produced no file");
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(saved);
    // A PDF, not an error page saved under a .pdf name.
    expect(bytes.subarray(0, 5).toString("latin1"), "what came back is not a PDF").toBe("%PDF-");
  } finally {
    await purge(admin, path);
  }
});

/** Whether the candidate has a resume on file, as the server serves it. */
async function hasResume(page: import("@playwright/test").Page, path: string): Promise<boolean> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return false;
  return !!((await res.json()) as { has_resume?: boolean }).has_resume;
}

/** The smallest thing a PDF reader will open - enough for the round trip to be about the bytes. */
const MINIMAL_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
