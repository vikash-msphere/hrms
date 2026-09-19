import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// Finding one document in somebody's file.
//
// The profile's Documents card lists a person's whole file at once (`all`, no pager), which is right - a file
// is read by scanning it - and becomes unusable at the length a long-tenured employee reaches. So the card
// carries a search box and a type picker, both client-side over rows already in hand. They appear only past a
// handful of documents, which is why this spec files its own set rather than borrowing whatever the shared
// employee happens to have: the toolbar's presence is part of what it asserts.
test("a long file is searched and filtered down on the profile's Documents card", async ({ as }) => {
  test.setTimeout(240_000);
  // Super: filing documents on somebody's record is `personal-documents` write, which the owner does not hold.
  const page = await as("super");
  const employee = await personPath(page, "employee");
  const id = employee.split("/")[1]!;
  const stamp = Date.now() % 100000;
  // Two types, so the type picker has something to choose BETWEEN - with one type it is a control whose every
  // option is the state it is already in, and the card leaves it out.
  const filed = [
    { document_type: "CONTRACT", display_name: `E2E Filter Contract ${stamp}` },
    { document_type: "CONTRACT", display_name: `E2E Filter Addendum ${stamp}` },
    { document_type: "ID", display_name: `E2E Filter Passport ${stamp}` },
    { document_type: "ID", display_name: `E2E Filter Licence ${stamp}` },
    { document_type: "OTHER", display_name: `E2E Filter Misc ${stamp}` },
  ];
  const paths: string[] = [];
  try {
    for (const doc of filed) {
      const made = await page.request.post("/v1/personal-documents", { headers: SPA_HEADERS, data: { ...doc, employee } });
      expect(made.status(), await made.text()).toBe(200);
      paths.push(((await made.json()) as { path: string }).path);
    }

    await gotoRoute(page, `employees/${id}`);
    await page.getByRole("tab", { name: "Documents" }).click();
    const card = page.getByRole("tabpanel");
    await expect(card.getByText(`E2E Filter Passport ${stamp}`)).toBeVisible({ timeout: 30_000 });

    // The search matches what the row SHOWS - its name here - as a plain substring. Typed as this run's stamp
    // alone, which every name this spec filed ends with, so the count is this spec's own whatever else is on
    // the record.
    const search = card.getByLabel("Search");
    await search.fill(String(stamp));
    await expect(card.getByText(`E2E Filter Misc ${stamp}`)).toBeVisible();
    await expect(card.getByText("Showing 5 of")).toBeVisible();

    // Crossed with the type picker, which offers only the types this person actually has.
    await card.getByLabel("Filter by type").click();
    await page.getByRole("option", { name: "Id", exact: true }).click();
    await expect(card.getByText(`E2E Filter Passport ${stamp}`)).toBeVisible();
    await expect(card.getByText(`E2E Filter Contract ${stamp}`)).toHaveCount(0);
    await expect(card.getByText("Showing 2 of")).toBeVisible();

    // Nothing left: the file is not empty, the filters are - and the way back is on the empty state rather
    // than in the reader's memory of what they typed.
    await search.fill(`nothing matches this ${stamp}`);
    await expect(card.getByText("No documents match.")).toBeVisible();
    await card.getByRole("button", { name: "Clear filters" }).click();
    await expect(card.getByText(`E2E Filter Contract ${stamp}`)).toBeVisible();
    await expect(card.getByText("Showing")).toHaveCount(0);
  } finally {
    for (const path of paths) await purge(page, path);
  }
});
