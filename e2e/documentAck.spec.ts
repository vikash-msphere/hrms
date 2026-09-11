import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// A policy everybody has to sign, signed.
//
// This is the app's heaviest browser-only chain, and every link of it is a rendered thing:
//
//   - HR uploads a PDF, turns on "require acknowledgement", and PLACES the signature box by clicking on a
//     rendering of the document itself (pdf.js paints it to a canvas; the click is converted into a box in
//     page coordinates). Nothing can be signed until that box exists, which the form enforces.
//   - the signer is shown the policy, signs it in place, and their signature image is stamped onto a
//     personal copy of the PDF.
//
// `test/documentAck.test.ts` and `test/esign.test.ts` own the records and the stamping. What they cannot do
// is place a box on a canvas or press a signature through a dialog.
//
// The signer here is HR, who is also an employee. That is the seeded policy talking: an ordinary employee
// holds NO org-documents access ("a grant opens it - the org's call", src/domain/grants.ts), so a company
// policy is invisible to them until somebody writes that rule - which this spec also asserts, because
// private-by-default is the behaviour, not an accident.
test("a policy is published for signature, signed in place, and hidden from those without access", async ({ as }) => {
  test.setTimeout(180_000);
  const hr = await as("hr");
  const employee = await as("employee");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). The dialog closing and the document appearing for its signer are
  // what prove the upload landed; a console line from a request retried behind that is not this failure.
  allowConsoleErrors(hr, /status of 503|status of 500/i);
  const title = `E2E policy ${Date.now()}`;

  // The signer needs a signature on file - it is the image that gets stamped. (`signature` owns the upload
  // UI; here it arrives through the API so this spec stays about the acknowledgement.)
  await putSignature(hr);

  await gotoRoute(hr, "documents", "Documents");
  await hr.getByRole("button", { name: "Upload document" }).click();
  const form = hr.getByRole("dialog");
  await form.locator('input[type="file"]').setInputFiles({
    name: "e2e-policy.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(PDF, "latin1"),
  });
  await form.getByLabel("Title").fill(title);

  // Requiring acknowledgement turns the dialog into a two-column form: the fields, and the document with
  // the signature box to place. Until the box is placed the submit is refused, with the reason.
  await form.getByRole("checkbox", { name: /Require acknowledgement/i }).click();
  const submit = form.getByRole("button", { name: "Upload", exact: true });
  await expect(form.getByText("Signature placement")).toBeVisible();
  await expect(submit).toBeDisabled();

  // Place it: a click on the rendered page, which is the only way this can be driven.
  const placer = form.locator("div.cursor-crosshair");
  await expect(placer).toBeVisible();
  await placer.click({ position: { x: 120, y: 200 } });
  await expect(submit).toBeEnabled();
  await submit.click();
  // The dialog closing is the upload landing; the toast is taken when it is caught, but is not what this
  // waits on - it lives about five seconds and a loaded machine misses it, which says nothing about whether
  // the document was created. The signer finding it below is the real proof either way.
  await expect(toast(hr, "Document uploaded")).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
  await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The signer's side: what is waiting on their signature is put in front of them rather than filed
  // somewhere they have to find.
  await hr.reload();
  await expect(hr.getByRole("main")).toBeVisible();
  // On the row, by its exact name: the table's own "Acknowledgement" column header is a button too (that is
  // how DataTable sorts), and a loose /Acknowledge/ matches the header first - which sorts the table and
  // opens nothing.
  const sign = hr.locator("tbody tr").filter({ hasText: title }).getByRole("button", { name: "Sign", exact: true });
  await expect(sign).toBeVisible();
  await sign.click();

  const dialog = hr.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /signature/i }).first()).toBeVisible();

  // The consent gate: the document is READ in the dialog, and the agreement cannot be given until the
  // reader has reached the last page. "I agree" on an unread policy is the thing this feature exists to
  // prevent, and it is enforced entirely in the rendered reader.
  const agree = dialog.getByRole("checkbox");
  // Waited for before it is judged: the dialog renders the document itself, and the agreement - gate and all
  // - is drawn once the reader is there. An assertion that the box is disabled, made before the box exists,
  // is a race with the render rather than a check of the gate.
  await expect(agree).toBeVisible({ timeout: 30_000 });
  await expect(agree).toBeDisabled();
  await expect(dialog.getByText("Scroll to the end of the document first.")).toBeVisible({ timeout: 30_000 });
  // Every scrolling box in the dialog, not the last one: the dialog body scrolls too, and the reader's own
  // column is the one whose end unlocks the gate - which of them is "last" in the DOM is not this test's
  // business. The reader watches for its final page coming into view, so it needs a real scroll to happen.
  await expect(async () => {
    await dialog.locator("div.overflow-auto, div.overflow-y-auto").evaluateAll((els) => {
      for (const el of els) el.scrollTop = el.scrollHeight;
    });
    await expect(agree).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  await agree.click();
  await dialog.getByRole("button", { name: /^Acknowledge/ }).click();

  // Signed: the page says so rather than still asking, and a stamped personal copy has been filed under
  // the signer's own documents (which is what makes the signature theirs to keep).
  await expect(hr.getByText(/Signed|Acknowledged/).first()).toBeVisible();
  await expect.poll(() => signedCopies(hr, title), { timeout: 15_000 }).toBeGreaterThan(0);

  // And the other half of private-by-default: somebody with no org-documents grant does not see it at all.
  await gotoRoute(employee, "documents", "Documents");
  await expect(employee.getByText(title)).toHaveCount(0);

  await clearSignature(hr);
  await purgeNamed(hr, "org-documents", title);
  await purgeNamed(hr, "personal-documents", title);
});

/** Put a signature image on the signer's employee record - the image the stamp uses. */
async function putSignature(page: import("@playwright/test").Page) {
  // `users/me` carries the employee as a REF (`employees/<token>`), which is the wire id the custom method
  // wants - the shell's `employee_id` is derived from it client-side.
  const me = await page.request.get("/v1/users/me");
  const { employee } = (await me.json()) as { employee?: string };
  const employee_id = (employee ?? "").split("/")[1];
  expect(employee_id, "the signed-in account has no employee record").toBeTruthy();
  const res = await page.request.post(`/v1/employees/${employee_id}:uploadSignature?content_type=image%2Fpng`, {
    headers: { ...SPA_HEADERS, "Content-Type": "application/octet-stream" },
    data: Buffer.from(PNG_1x1, "base64"),
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** Take it off again, so the seeded employee is as they were. */
async function clearSignature(page: import("@playwright/test").Page) {
  // `users/me` carries the employee as a REF (`employees/<token>`), which is the wire id the custom method
  // wants - the shell's `employee_id` is derived from it client-side.
  const me = await page.request.get("/v1/users/me");
  const { employee } = (await me.json()) as { employee?: string };
  const employee_id = (employee ?? "").split("/")[1];
  expect(employee_id, "the signed-in account has no employee record").toBeTruthy();
  await page.request.post(`/v1/employees/${employee_id}:clearSignature`, { headers: SPA_HEADERS });
}

/** How many personal (signed) copies of this policy exist for the caller. */
async function signedCopies(page: import("@playwright/test").Page, title: string): Promise<number> {
  const res = await page.request.get("/v1/personal-documents?page_size=100");
  if (!res.ok()) return 0;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  return results.filter((r) => (r.display_name ?? "").includes(title)).length;
}

/** Purge documents by title. */
async function purgeNamed(page: import("@playwright/test").Page, collection: string, title: string) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) if ((r.display_name ?? "").startsWith(title)) await purge(page, r.path!);
}

const PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
