import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The IT admin's help desk, and HR's PIN reset - the two ways the seeded roles changed hands.
//
// it_admin holds no ticket rule of its own: a ticket's code is its requester's, so no rule can say "IT tickets".
// The `it` category names it_admin as a servicing role, and each ticket filed there is shared with the role
// (services/ticketShares.ts). So the IT admin reads and resolves an IT ticket, and cannot open an HR one.
test("the IT admin works the IT desk and cannot reach another desk's ticket", async ({ as }) => {
  test.setTimeout(120_000);
  const employee = await as("employee");
  const it = await as("it");
  const stamp = Date.now();

  const raise = async (category: string, subject: string) => {
    const made = await employee.request.post("/v1/tickets", { headers: SPA_HEADERS, data: { subject, category, description: "Raised by the e2e suite." } });
    expect(made.status(), await made.text()).toBe(200);
    return ((await made.json()) as { path: string }).path;
  };
  const itTicket = await raise("it", `E2E IT desk ${stamp}`);
  const hrTicket = await raise("hr", `E2E HR desk ${stamp}`);

  try {
    expect((await it.request.get(`/v1/${itTicket}`)).status()).toBe(200);
    expect([403, 404]).toContain((await it.request.get(`/v1/${hrTicket}`)).status());
    expect([403, 404]).toContain((await it.request.post(`/v1/${hrTicket}:resolve`, { headers: SPA_HEADERS })).status());

    await gotoRoute(it, "tickets", "Support");
    await it.getByRole("button", { name: /^All/ }).click();
    const row = it.locator("tbody tr").filter({ hasText: `E2E IT desk ${stamp}` });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(it.locator("tbody tr").filter({ hasText: `E2E HR desk ${stamp}` })).toHaveCount(0);

    const resolved = await it.request.post(`/v1/${itTicket}:resolve`, { headers: SPA_HEADERS });
    expect(resolved.status(), await resolved.text()).toBe(200);
  } finally {
    const admin = await as("super");
    await purge(admin, itTicket);
    await purge(admin, hrTicket);
  }
});

// HR opens Settings, Users read-only: the list and Reset app PIN, nothing that edits an account. The reset is
// made on a throwaway employee's own login, never a seeded one - it signs the person out everywhere, which would
// take down every other spec signed in as them.
test("HR resets a forgotten app PIN from the Users list, and can edit no account", async ({ as }) => {
  test.setTimeout(120_000);
  const admin = await as("super");
  const hr = await as("hr");
  const stamp = Date.now();
  const email = `e2e.pin.${stamp}@example.com`;
  const made = await admin.request.post("/v1/employees", { headers: SPA_HEADERS, data: { first_name: "E2E", last_name: `Pin${stamp}`, work_email: email } });
  expect(made.status(), await made.text()).toBe(200);
  const employee = ((await made.json()) as { path: string }).path;

  try {
    await gotoRoute(hr, "settings/users", "Users");
    const row = hr.locator("tbody tr").filter({ hasText: email });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "User actions" }).click();
    await expect(hr.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
    await expect(hr.getByRole("menuitem", { name: "Manage permissions" })).toHaveCount(0);
    await hr.getByRole("menuitem", { name: "Reset app PIN" }).click();
    const confirm = hr.getByRole("alertdialog").or(hr.getByRole("dialog")).filter({ hasText: `Reset the app PIN for ${email}?` });
    await confirm.getByRole("button", { name: "Reset PIN", exact: true }).click();
    await expect(toast(hr, "App PIN reset")).toBeVisible({ timeout: 30_000 });
  } finally {
    const got = await admin.request.get(`/v1/${employee}`);
    if (got.ok()) {
      const { etag } = (await got.json()) as { etag: string };
      await admin.request.delete(`/v1/${employee}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
    }
  }
});
