import { SPA_HEADERS, gotoRoute, personId, test, expect } from "./fixtures";

// A face on the record.
//
// The profile photo is the app's other private image (the first is the signature): the bytes are cropped IN
// THE BROWSER - a square cut out of whatever was chosen, at whatever zoom and offset the person dragged to -
// and only then sent as an octet-stream. Nothing outside a browser does any of that: there is no upload form
// that posts a file, there is a canvas, and what reaches the server is an image this page drew.
//
// `test/employeePhoto.test.ts` owns the storage and the access rule. What only a browser shows is the chain:
// the picker, the crop preview appearing (which is the FileReader and the image decode having worked), the
// save, and the avatar afterwards - plus the removal, which asks first because the image cannot be recovered.
//
// Self-service, so the employee drives their own: `employees.me.uploadPhoto` / `.clearPhoto` are the seeded
// grants an ordinary person holds, and an admin doing it would be testing a different rule.
test("an employee sets their profile photo, and takes it off again", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("employee");
  const id = await personId(page, "employee");

  await gotoRoute(page, "profile"); // one record page, two addresses: its `h1` is the person's name
  await page.getByRole("button", { name: "Change photo" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Profile photo")).toBeVisible({ timeout: 30_000 });

  try {
    // The picker is a hidden input behind a drop zone, which is what `setInputFiles` drives.
    await dialog.locator('input[type="file"]').first().setInputFiles({
      name: "face.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_1x1, "base64"),
    });

    // The crop preview: this only appears once the file has been read AND decoded, so it is the proof the
    // browser half of the upload happened at all. The zoom control comes with it.
    await expect(dialog.getByRole("img", { name: "crop preview" })).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Drag to reposition")).toBeVisible();

    await dialog.getByRole("button", { name: "Save photo" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // Stored against the record - the marker every avatar in the app keys its cache on. Read from the server
    // rather than from the page, so this is the upload having landed rather than the dialog having closed.
    await expect.poll(() => photoMarker(page, id), { timeout: 30_000 }).toBeTruthy();

    // And off again, through the affordance rather than the API - which asks first, because the image cannot
    // be recovered and the button sits next to Save.
    await page.getByRole("button", { name: "Change photo" }).first().click();
    const again = page.getByRole("dialog").filter({ hasText: "Profile photo" });
    await expect(again).toBeVisible({ timeout: 30_000 });
    await again.getByRole("button", { name: "Remove photo" }).click();
    const ask = page.getByRole("dialog").filter({ hasText: "Remove this photo?" });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(ask.getByText(/falls back to initials/)).toBeVisible();
    await ask.getByRole("button", { name: "Remove", exact: true }).click();

    await expect.poll(() => photoMarker(page, id), { timeout: 30_000 }).toBeFalsy();
  } finally {
    // A safety net for a run that died mid-way: a seeded person left wearing a 1x1 png is what every other
    // spec's org chart, directory and approval queue would then draw.
    await page.request.post(`/v1/employees/${id}:clearPhoto`, { headers: SPA_HEADERS }).catch(() => undefined);
  }
});

/** The photo marker on this person's record, as the server serves it. */
async function photoMarker(page: import("@playwright/test").Page, id: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/employees/${id}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { photo?: string }).photo;
}

// A 1x1 transparent PNG - the smallest real image a browser will decode, so the crop preview appearing is a
// fact about the bytes rather than about the element.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
