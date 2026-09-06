import { gotoRoute, test, expect, toast } from "./fixtures";

// Putting a signature on file, and getting it back as a picture.
//
// The signature is the one image in the app that is never a plain `<img src>`: the bytes go up as an
// octet-stream to `:uploadSignature`, and come back down through a POST to `:getSignature` whose ArrayBuffer
// is turned into a blob URL (a signature is not public, so it cannot be a URL a browser fetches on its own).
// `test/employeeSignature.test.ts` owns the storage and the access rule; every link in the chain AFTER the
// response - the blob URL, its revocation on unmount, the refetch that has to happen when the marker string
// did not change - exists only in a browser, and a break in any of them looks like an empty white sheet
// where somebody's signature should be.
//
// Signed in as the employee, because this is self-service: the person's own signature on their own profile.
test("an employee uploads their signature, sees it, and takes it off again", async ({ as }) => {
  const page = await as("employee");
  await gotoRoute(page, "profile", "My Profile");
  await page.getByRole("tab", { name: "Signature" }).click();

  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("No signature uploaded yet.")).toBeVisible();

  await panel.locator('input[type="file"]').setInputFiles({
    name: "signature.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1, "base64"),
  });

  await expect(toast(page, "Signature updated")).toBeVisible();
  // The picture, not just the row: this only paints if the fetch, the ArrayBuffer and the blob URL all held.
  const image = panel.getByRole("img", { name: "Your signature" });
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("naturalWidth", 1);

  // A fresh page: the marker on the employee record is what tells the panel to go and fetch at all.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("tab", { name: "Signature" }).click();
  await expect(page.getByRole("tabpanel").getByRole("img", { name: "Your signature" })).toBeVisible();

  // And off again, so a rerun starts from the same empty sheet - and so the letters and acknowledgements
  // that render a seeded employee's signature are not quietly changed by this spec.
  await page.getByRole("tabpanel").getByRole("button", { name: "Remove" }).click();
  await expect(toast(page, "Signature removed")).toBeVisible();
  await expect(page.getByRole("tabpanel").getByText("No signature uploaded yet.")).toBeVisible();
});

// A 1x1 transparent PNG - the smallest real image a browser will decode, so `naturalWidth` is a fact about
// the bytes that made the round trip rather than about the element.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
