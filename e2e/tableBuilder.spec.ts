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
    path = new URL(page.url()).pathname.split("/")[2] ?? null;

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
    path = new URL(page.url()).pathname.split("/")[2] ?? null;

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

    // Both columns are on the grid: one from the person, one from their manager's department. The second is
    // headed "Department" rather than "Name" - a linked column is named by the link that reaches it, and the
    // trail above that link is spent only on telling two columns apart, which nothing here needs.
    await expect(page.getByRole("columnheader", { name: "First name" })).toBeVisible({ timeout: 30_000 });
    // A column header's accessible name carries its filter button too ("Department Filter by department"),
    // so this is anchored rather than exact.
    await expect(page.getByRole("columnheader", { name: /^Department\b/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/hidden from you/)).toHaveCount(0);

    // Reopening the picker: the chosen list calls each column what the grid calls it, and says the trail
    // under it. It used to name a column off the nodes this picker session had WALKED, so a column two hops
    // out came back as `manager_id.department_id.name` - the storage key - until somebody went and found it
    // again.
    // Once the table HAS columns the page header counts them ("Columns (2)"), and "Pick columns" is the
    // empty state's own button, which is gone.
    await page.getByRole("button", { name: "Columns (2)" }).click();
    const reopened = page.getByRole("dialog");
    await expect(reopened.getByText("On the table, in order")).toBeVisible({ timeout: 15_000 });
    await expect(reopened.getByRole("textbox", { name: "Header for Manager -> Department: Name" })).toHaveAttribute("placeholder", "Department");
    await expect(reopened.getByText("Manager -> Department: Name")).toBeVisible();
    await expect(reopened.getByText(/manager_id\./)).toHaveCount(0);
    await reopened.getByRole("button", { name: "Cancel" }).click();
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
    path = new URL(page.url()).pathname.split("/")[2] ?? null;

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

// A grid is a thing you WORK, not a screenshot: the header a column shows is the author's own word for it,
// the rows summarise into a picture you can press, the table's own filter is saved on the definition rather
// than typed into the browser each time, and a row leads back to the record it came from.
//
// All four were missing from the page while the server already took three of them: `label`, `filters` and
// `sort` are fields of a saved view that nothing in the SPA could edit.
test("a table renames a column, summarises its rows, saves a filter, and opens the record behind a row", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const name = `E2E worked ${Date.now() % 100000}`;
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
    path = new URL(page.url()).pathname.split("/")[2] ?? null;

    // One text column and one money column: enough for a group-by, a total, and a header worth renaming.
    await page.getByRole("button", { name: "Pick columns" }).click();
    const picker = page.getByRole("dialog");
    for (const field of ["First name", "Annual CTC"]) {
      await picker.getByPlaceholder(/Search .* fields/).fill(field);
      await picker.getByRole("checkbox").first().check();
    }
    // The catalogue's name for a field is mechanical; what the table calls it is the author's. Renaming it is
    // an edit of the definition, so it is what every reader of the table sees.
    await picker.getByLabel("Header for First name").fill("Given name");
    await picker.getByRole("button", { name: "Save columns" }).click();
    await expect(page.getByRole("columnheader", { name: /^Given name/ })).toBeVisible({ timeout: 30_000 });

    // The strip over the grid: what one screenful of the report adds up to.
    await expect(page.getByText("Total annual ctc")).toBeVisible({ timeout: 30_000 });

    // Summarise: one bar per value of the first column that has repeated values, drawn from the rows in hand.
    await page.getByRole("button", { name: "Summarise" }).click();
    await expect(page.getByText("Rows by Given name")).toBeVisible({ timeout: 30_000 });

    // And it is a REAL chart, judged the way everyChart.spec.ts judges every other one: a picture with a box,
    // and the same numbers in a table under it for a reader who cannot see the picture. This is the chart that
    // spec's page walk cannot reach - it only exists on a saved table, after a press - so `ELSEWHERE` there
    // names this spec, and these three assertions are what that name promises.
    const figure = page.locator("figure").filter({ has: page.locator("figcaption") }).first();
    const svg = figure.locator("svg").first();
    await expect(svg).toBeAttached({ timeout: 30_000 });
    // Polled rather than measured once: `Chart` is lazy and the library sizes its SVG a frame or more after
    // the element lands, so a single read is a race on a loaded machine.
    await expect
      .poll(async () => { const b = await svg.boundingBox(); return (b?.width ?? 0) > 0 && (b?.height ?? 0) > 0; }, { timeout: 15_000 })
      .toBe(true);
    const caption = ((await figure.locator("figcaption").first().textContent()) ?? "").trim();
    const numbers = figure.locator("table");
    await expect(numbers.locator("caption")).toHaveText(caption);
    await expect(numbers.locator("tbody tr").first()).toBeAttached({ timeout: 30_000 });

    // Each control over the picture says what it changes, rather than leaving the reader to open it and find
    // out - and one of them is the picture itself. The shape rides in the URL with the group and the measure,
    // so the chart somebody sends on is the chart they were looking at.
    for (const control of ["Group by", "Measure", "Chart"]) {
      await expect(page.getByText(control, { exact: true })).toBeVisible();
    }
    await page.getByLabel("Chart type").click();
    await page.getByRole("option", { name: "Pie", exact: true }).click();
    await expect(page).toHaveURL(/chart=pie/, { timeout: 15_000 });
    await expect(page.getByText(/Click a slice/)).toBeVisible({ timeout: 15_000 });

    // A share is a fraction of a total, so it is offered only where the groups add up to one. An average does
    // not, and the picture falls back to the bars it can honestly draw.
    await page.getByLabel("Measure").click();
    await page.getByRole("option", { name: /^Average/ }).first().click();
    await expect(page.getByText(/Click a bar/)).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Chart type").click();
    await expect(page.getByRole("option", { name: "Bars", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: "Pie", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: "Bars", exact: true }).click();
    // Back to the count, so what follows reads the table it started with.
    await page.getByLabel("Measure").click();
    await page.getByRole("option", { name: "Number of rows", exact: true }).click();

    // The table's OWN filter - saved on the view, applied by the server to every page. "is not empty" needs no
    // typed value, so what this proves is the round trip rather than one particular comparison.
    await page.getByRole("button", { name: /^Filter & sort/ }).click();
    const sheet = page.getByRole("dialog").filter({ hasText: "Filter & sort" });
    await sheet.getByRole("button", { name: "Add filter" }).click();
    await sheet.getByLabel("Condition").click();
    await page.getByRole("option", { name: "is not empty", exact: true }).click();
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Given name is not empty")).toBeVisible({ timeout: 30_000 });

    // It is on the definition, not in this browser: it comes back with the table.
    await page.reload();
    await expect(page.getByText("Given name is not empty")).toBeVisible({ timeout: 30_000 });

    // And a row is a record. The grid is built on People, so its rows lead to the profile.
    //
    // Scoped to the row, not `getByRole("button", { name: "Actions" })` over the page: a clickable DataTable
    // row IS a button, and its accessible name is everything inside it - including the row-actions trigger's
    // own "Actions" label. An unscoped locator therefore matched the row first and pressing it navigated,
    // which is the right behaviour arriving through the wrong element.
    const firstRow = page.locator('tbody tr[role="button"]').first();
    await firstRow.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Open record" }).click();
    await expect(page).toHaveURL(/\/employees\//, { timeout: 30_000 });
  } finally {
    if (path) await purge(page, `table-views/${path}`);
  }
});
