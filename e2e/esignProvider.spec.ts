import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The external e-signature vendor, as far as this lane can reach it.
//
// Signing in this app has two lanes: the in-app signature (`documentAck`, `signature`) and an external
// Aadhaar vendor. The vendor lane cannot be completed here - it needs credentials the deployment
// deliberately ships without, and a hosted page on somebody else's domain - but the two places it TOUCHES
// the browser can be, and both are the difference between a clear answer and a 500:
//
//   - the vendor's settings are rendered from the SERVER's driver registry (`/v1/esign-providers`), not from
//     a list in the page. That is the whole "add a provider" contract (docs/05-add-esign-provider.md): a
//     driver with new config fields has to grow the panel without anybody editing the panel;
//   - the guards around it: the form refusing an acknowledgement with no signature box placed, and a vendor
//     signing request that cannot go through coming back as a readable precondition - the missing environment
//     variable, or the vendor's own complaint - rather than a 500 with a half-made copy behind it.
test.describe("the e-signature vendor lane", () => {
  test("the vendor's settings are rendered from the server's driver registry", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");

    // What the server says it can drive, and what each driver needs configured.
    const res = await page.request.get("/v1/esign-providers");
    expect(res.status(), await res.text()).toBe(200);
    const { providers = [] } = (await res.json()) as {
      providers?: { id: string; label: string; configFields?: { label: string }[] }[];
    };
    const vendor = providers.find((p) => (p.configFields ?? []).length > 0);
    expect(vendor, "the registry offers no configurable vendor").toBeTruthy();

    await gotoRoute(page, "settings/esign", "E-signature");
    // The panel names the driver the server named...
    await expect(page.getByText(`${vendor!.label} settings`)).toBeVisible({ timeout: 30_000 });
    // ...and asks for exactly the fields that driver declared. A panel with its own hard-coded list would
    // pass the first assertion and quietly stop matching here.
    for (const field of vendor!.configFields ?? []) {
      await expect(page.getByLabel(field.label).first()).toBeVisible();
    }
    // The secrets are NOT here, and that is the design: they live in the server environment.
    await expect(page.getByText(/API keys are configured by your administrator/)).toBeVisible();
  });

  test("acknowledgement is refused until the box is placed, and a vendor request fails readably", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("super");
    const title = `E2E aadhaar ${Date.now() % 1_000_000}`;

    // Half of the guard is in the FORM. A policy that requires acknowledgement needs a box for the signature
    // to land in, and the box is placed by clicking the rendering of the PDF (`documentAck` drives that). Until
    // it is, the submit says what is missing rather than sending a document nobody could ever sign.
    await gotoRoute(page, "documents", "Documents");
    await page.getByRole("button", { name: "Upload document" }).click();
    const form = page.getByRole("dialog");
    await expect(form).toBeVisible({ timeout: 30_000 });

    // The file first: "Require acknowledgement" is only offered once the picked file IS a pdf, so this is the
    // order a person is forced into.
    await form.locator('input[type="file"]').first().setInputFiles({
      name: "policy.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(MINIMAL_PDF, "utf8"),
    });
    await form.getByLabel("Title").fill(title);
    await form.getByRole("checkbox", { name: "Require acknowledgement" }).check();
    await form.getByRole("button", { name: "Aadhaar e-Sign" }).click();

    const submit = form.getByRole("button", { name: "Upload", exact: true });
    await expect(submit).toBeDisabled();
    // The submit's own reason, exactly - the PDF pane beside it says something similar ("Click on the page to
    // place the signature box"), and matching loosely would pass on the hint while the button said nothing.
    await expect(form.getByText("Click on the document to place the signature box.")).toBeVisible({ timeout: 30_000 });

    // Nothing was created by a refused form.
    expect(await documentNamed(page, title), "a refused upload created a document anyway").toBeFalsy();
    await page.keyboard.press("Escape");
    const discard = page.getByRole("button", { name: /^(Discard|Leave)$/ });
    if (await discard.count()) await discard.first().click();

    // The other half is the SERVER's, and it is where this lane stops: a policy CAN be published against the
    // vendor (an org configures the credentials later), but the moment somebody tries to sign it the driver is
    // checked, and with no credentials in the environment the answer is a precondition naming the environment
    // variable an administrator has to set - not a 500 from inside the adapter with a half-made copy behind it.
    const made = await page.request.post("/v1/org-documents", {
      headers: SPA_HEADERS,
      data: {
        display_name: title,
        document_type: "POLICY",
        requires_ack: true,
        ack_method: "cashfree",
        sign_anchor: { page: 1, x1: 0.1, y1: 0.8, x2: 0.4, y2: 0.9 },
        notify_audience: { kind: "none" },
      },
    });
    expect(made.status(), await made.text()).toBe(200);
    const doc = ((await made.json()) as { path: string }).path;

    // The bytes, which a record created over the wire does not carry: signing reads the stored file first, so
    // without this the refusal below is "no file", which says nothing about the vendor.
    const stored = await page.request.post(`/v1/${doc}:upload?file_name=policy.pdf&content_type=application%2Fpdf`, {
      headers: { ...SPA_HEADERS, "Content-Type": "application/pdf" },
      data: Buffer.from(MINIMAL_PDF, "utf8"),
    });
    expect(stored.status(), await stored.text()).toBe(200);

    try {
      // The browser's part: the policy is offered for signing like any other, because whether the vendor is
      // configured is not something the reader can know or fix.
      await page.reload();
      await expect(page.getByRole("main")).toBeVisible();
      const row = page.locator("tbody tr").filter({ hasText: title }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.hover();
      await row.getByRole("button", { name: "Actions" }).click();
      // Exact: the same menu carries "View acknowledgements", which a substring match also finds.
      await expect(page.getByRole("menuitem", { name: "Acknowledge", exact: true })).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");

      // And the refusal, asserted where it is decided. Driven over the wire because the signing flow past this
      // point is a hosted page on the vendor's own domain.
      //
      // What is pinned is the SHAPE of the refusal, not one sentence: whether the driver stops at "no
      // credentials in this environment" or the vendor itself refuses the request depends on what the machine
      // running the lane has in its `.dev.vars`, and both are the same claim - the adapter answers with a
      // failed precondition naming what went wrong, rather than a 500 from inside it.
      const refused = await page.request.post(`/v1/${doc}:acknowledge`, { headers: SPA_HEADERS });
      const body = await refused.text();
      expect(refused.status(), `the vendor lane signed something: ${body}`).toBe(409);
      expect(body).toMatch(/failed-precondition/);
      expect(body).toMatch(/ESIGN_[A-Z_]+|not configured|missing|e-sign request failed/i);
    } finally {
      await purge(page, doc);
    }
  });
});

/** Whether the caller has acknowledged this document. */
async function acknowledged(page: import("@playwright/test").Page, path: string): Promise<boolean> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return false;
  return !!((await res.json()) as { acknowledged?: boolean }).acknowledged;
}

/** The wire path of an org document by name, if the server has one. */
async function documentNamed(page: import("@playwright/test").Page, title: string): Promise<string | undefined> {
  const res = await page.request.get("/v1/org-documents?page_size=200", { headers: SPA_HEADERS });
  if (!res.ok()) return undefined;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  return results.find((d) => d.display_name === title)?.path;
}

/** The smallest thing a PDF reader will open. */
const MINIMAL_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
