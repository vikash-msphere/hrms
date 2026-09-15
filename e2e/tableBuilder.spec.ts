import { gotoRoute, purge, test, expect } from "./fixtures";

// The custom-grid builder, end to end through the UI it is actually used from: name a table, say what one row
// is, pick fields that live in three different places (an employee column, an identity field, the compensation
// the payroll module owns), and get one grid with all of them in it.
//
// What this proves that the unit tests cannot: the catalogue the picker renders is the server's own answer, the
// column keys the SPA saves are the ones `:run` resolves, and a saved table survives a reload as a thing you
// come back to rather than as a screen you built once.
test("a saved table mixes fields from three collections, and comes back the same after a reload", async ({ as }) => {
  test.setTimeout(180_000);
  // Tables are private by default - no seeded grant names `table-views` - so super is the caller who has them
  // until an admin grants the capability, and the caller this spec must therefore be.
  const page = await as("super");
  const name = `E2E table ${Date.now() % 100000}`;
  let path: string | null = null;

  try {
    await gotoRoute(page, "tables", "Tables");

    // `.first()`, as everywhere else this suite presses a page's create button: a list with nothing in it yet
    // offers the same action twice - once in the page header, once inside the empty state - so an unscoped
    // locator is a strict-mode violation on exactly the runs where no other spec's table happens to exist.
    await page.getByRole("button", { name: "New table" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("e.g. Salary sheet - March").fill(name);
    // "One row is": the base picker, filled from GET /v1/table-fields - the bases this caller may list. Its
    // options are portalled outside the dialog, so only the trigger is scoped to it.
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "People", exact: true }).click();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    // Landed on the table itself, empty until it has columns.
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No columns yet")).toBeVisible({ timeout: 30_000 });
    path = new URL(page.url()).hash.split("/")[2] ?? null;

    // Three fields, from three different collections: the employee row, the identity sub-resource (which is
    // field-access-gated and masked), and compensation (a different module entirely).
    await page.getByRole("button", { name: "Pick columns" }).click();
    const picker = page.getByRole("dialog");
    for (const field of ["First name", "PAN", "Annual CTC"]) {
      await picker.getByPlaceholder(/Search .* fields/).fill(field);
      await picker.getByRole("checkbox").first().check();
    }
    await picker.getByRole("button", { name: "Save columns" }).click();

    // The grid: one row per person this caller can list, with all three columns on it.
    for (const header of ["First name", "PAN", "Annual CTC"]) {
      await expect(page.getByRole("columnheader", { name: header })).toBeVisible({ timeout: 30_000 });
    }
    // A seeded person, proving the rows are real rows rather than an empty shell with headers.
    await expect(page.getByRole("cell", { name: /\w/ }).first()).toBeVisible({ timeout: 30_000 });
    // Nothing was withheld from super, so the "hidden from you" notice must not be on screen.
    await expect(page.getByText(/hidden from you/)).toHaveCount(0);

    // A saved table is a record you come back to, not a screen you built once.
    await page.reload();
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("columnheader", { name: "Annual CTC" })).toBeVisible({ timeout: 30_000 });

    // And it is listed among the saved tables.
    await gotoRoute(page, "tables", "Tables");
    await expect(page.getByText(name)).toBeVisible({ timeout: 30_000 });
  } finally {
    if (path) await purge(page, `table-views/${path}`);
  }
});

// The join: a field that references another collection is somewhere to GO, and the record it points at brings
// its own fields - and its own references after that. Walked here two hops from a person, to the name of the
// department their manager is in, which is a column no single collection holds.
test("the picker follows a reference into another collection, and its fields become columns", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const name = `E2E join ${Date.now() % 100000}`;
  let path: string | null = null;

  try {
    await gotoRoute(page, "tables", "Tables");
    await page.getByRole("button", { name: "New table" }).first().click();
    const create = page.getByRole("dialog");
    await create.getByPlaceholder("e.g. Salary sheet - March").fill(name);
    await create.getByRole("combobox").click();
    await page.getByRole("option", { name: "People", exact: true }).click();
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });
    path = new URL(page.url()).hash.split("/")[2] ?? null;

    await page.getByRole("button", { name: "Pick columns" }).click();
    const picker = page.getByRole("dialog");

    // A column of the person themselves.
    await picker.getByPlaceholder(/Search .* fields/).fill("First name");
    await picker.getByRole("checkbox").first().check();
    await picker.getByPlaceholder(/Search .* fields/).fill("");

    // Then follow the reference: Manager is a person too, and their Department is a department.
    await expect(picker.getByText("Related records")).toBeVisible({ timeout: 15_000 });
    await picker.getByRole("button", { name: /^Manager/ }).click();
    await expect(picker.getByRole("button", { name: /^Department/ })).toBeVisible({ timeout: 15_000 });
    await picker.getByRole("button", { name: /^Department/ }).click();

    // Two hops out, this node's own fields are on offer - and picking one keeps the column picked back at the
    // base, because the trail is where you are standing, not what you have chosen.
    await picker.getByPlaceholder(/Search .* fields/).fill("Name");
    await picker.getByRole("checkbox").first().check();
    await picker.getByRole("button", { name: "Save columns" }).click();

    // Both columns are on the grid: one from the person, one from their manager's department.
    await expect(page.getByRole("columnheader", { name: "First name" })).toBeVisible({ timeout: 30_000 });
    // A column header's accessible name carries its filter button too ("Name Filter by name"), so this is
    // anchored rather than exact.
    await expect(page.getByRole("columnheader", { name: /^Name\b/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/hidden from you/)).toHaveCount(0);
  } finally {
    if (path) await purge(page, `table-views/${path}`);
  }
});

// Picking the wrong base is the first mistake anybody makes, and it used to mean deleting the table and
// starting again. It is an edit: the base changes, the columns that named the old base's fields are cleared
// after saying so, and the picker comes back filled with the NEW base's fields.
test("the base of a saved table can be changed, and the columns are cleared with a warning", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const name = `E2E rebase ${Date.now() % 100000}`;
  let path: string | null = null;

  try {
    await gotoRoute(page, "tables", "Tables");
    await page.getByRole("button", { name: "New table" }).first().click();
    const create = page.getByRole("dialog");
    await create.getByPlaceholder("e.g. Salary sheet - March").fill(name);
    await create.getByRole("combobox").click();
    await page.getByRole("option", { name: "People", exact: true }).click();
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });
    path = new URL(page.url()).hash.split("/")[2] ?? null;

    // One column, so the change has something to cost.
    await page.getByRole("button", { name: "Pick columns" }).click();
    const picker = page.getByRole("dialog");
    await picker.getByPlaceholder(/Search .* fields/).fill("First name");
    await picker.getByRole("checkbox").first().check();
    await picker.getByRole("button", { name: "Save columns" }).click();
    await expect(page.getByRole("columnheader", { name: "First name" })).toBeVisible({ timeout: 30_000 });

    // Change what a row is. The prompt names the cost before the change, not after the save.
    await page.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog").filter({ hasText: "Edit table" });
    await edit.getByRole("combobox").click();
    await page.getByRole("option", { name: "Departments", exact: true }).click();
    const warn = page.getByRole("dialog").filter({ hasText: "Change what one row is?" });
    await expect(warn).toBeVisible({ timeout: 15_000 });
    await warn.getByRole("button", { name: "Change and clear columns" }).click();
    await edit.getByRole("button", { name: "Save changes" }).click();

    // The old base's column is gone and the table is asking for the new base's.
    await expect(page.getByText("No columns yet")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("columnheader", { name: "First name" })).toHaveCount(0);

    // And the picker now offers what a DEPARTMENT has, not what a person has: its own name and the manager
    // it links to, with no first name and no identity fields anywhere in it.
    await page.getByRole("button", { name: "Pick columns" }).click();
    const repicker = page.getByRole("dialog");
    await expect(repicker.getByText("Departments", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await repicker.getByPlaceholder(/Search .* fields/).fill("First name");
    await expect(repicker.getByText(/No fields match/)).toBeVisible({ timeout: 15_000 });
  } finally {
    if (path) await purge(page, `table-views/${path}`);
  }
});

// A table with no columns still answers - the empty state is the builder's own prompt, not an error, and the
// run endpoint is never asked for a grid of nothing.
test("a table deleted from the list disappears from it", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E doomed ${Date.now() % 100000}`;

  await gotoRoute(page, "tables", "Tables");
  await page.getByRole("button", { name: "New table" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("e.g. Salary sheet - March").fill(name);
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "People", exact: true }).click();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });

  await gotoRoute(page, "tables", "Tables");
  // The table's rows are clickable, so each row is a `button` carrying its cells rather than a `row`.
  const row = page.getByRole("button").filter({ hasText: name }).first();
  await row.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: name });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(name)).toHaveCount(0, { timeout: 30_000 });
});
