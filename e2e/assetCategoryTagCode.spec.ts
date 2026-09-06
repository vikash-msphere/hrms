import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

type Cat = { path: string; display_name?: string; tag_code?: string };

// The asset category tag code (Settings → Asset tags → Categories) - every other asset spec creates its
// category straight through the wire API with `requires_serial: false` and no tag code at all, so none of
// this panel's own rule has ever run: a code nobody typed is only a DEFAULT (the first three letters of the
// name), and steps aside to the next free number when another category already answers to it - "Laptop" and
// "Laptop dock" both derive LAP, so the second becomes LAP2 rather than refusing to save. A code someone DID
// type is never moved that way: the clash is the author's to resolve, surfaced as the server's own error
// since nothing here checks it client-side before the request is sent.
test("a blank tag code derives and steps aside on a clash; a typed one that clashes is refused", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  // The clash below is refused by the server on purpose, and the browser logs every failed load. That 409 is
  // the behaviour under test, not the app breaking.
  allowConsoleErrors(page, /status of 409/);
  const stamp = Date.now() % 100000;
  const nameA = `Zeta one E2E asset category ${stamp}`;
  const nameB = `Zeta two E2E asset category ${stamp}`;
  const nameC = `Zeta three E2E asset category ${stamp}`;

  await gotoRoute(page, "settings/asset-tags");
  await page.getByRole("tab", { name: "Categories" }).click();

  // A: no tag code typed - derives from the name's own first three letters.
  await page.getByRole("button", { name: "New category" }).first().click();
  let form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(nameA);
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(nameA)).toBeVisible({ timeout: 30_000 });

  // B: same first three letters, also left blank - steps aside to the next free number rather than
  // refusing to save over a code its author never even saw.
  await page.getByRole("button", { name: "New category" }).first().click();
  form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(nameB);
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(nameB)).toBeVisible({ timeout: 30_000 });

  let pathA: string | undefined, pathB: string | undefined, pathC: string | undefined;
  try {
    const listed = await page.request.get("/v1/asset-categories?page_size=200");
    const { results = [] } = (await listed.json()) as { results?: Cat[] };
    const catA = results.find((c) => c.display_name === nameA);
    const catB = results.find((c) => c.display_name === nameB);
    expect(catA?.tag_code, "A's derived code").toBe("ZET");
    expect(catB?.tag_code, "B's derived code steps aside on the clash").toBe("ZET2");
    pathA = catA!.path;
    pathB = catB!.path;

    // C: a tag code TYPED explicitly, colliding with A's - refused, not renumbered, and the dialog stays
    // open on the server's own reason since nothing here pre-checks it.
    await page.getByRole("button", { name: "New category" }).first().click();
    form = page.getByRole("dialog");
    await form.getByLabel("Name").fill(nameC);
    await form.getByLabel("Tag code").fill("zet");
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect(form.getByText("tag code ZET is already used by another category")).toBeVisible({ timeout: 15_000 });

    // Corrected to a code that is actually free, the same request goes through.
    await form.getByLabel("Tag code").fill("zqe");
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    const relisted = await page.request.get("/v1/asset-categories?page_size=200");
    const { results: r2 = [] } = (await relisted.json()) as { results?: Cat[] };
    const catC = r2.find((c) => c.display_name === nameC);
    expect(catC?.tag_code).toBe("ZQE");
    pathC = catC!.path;
  } finally {
    for (const p of [pathA, pathB, pathC]) if (p) await purge(page, p);
  }
});
