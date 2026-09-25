import type { Page } from "@playwright/test";
import { SPA_HEADERS, allowConsoleErrors, gotoRoute, makeThrowawayPerson, retireThrowawayPerson, test, expect, toast, userPath, ymd } from "./fixtures";

// Bringing in what happened before HRMS for somebody who joined before it (web/src/pages/OpeningBalances.tsx
// and every screen that reads what it brings in): the page's three imports, the records-start date on the
// employee record and the attendance it changes, the leave page's adjustments, balance history and imported
// leave, and the Tax page and payroll build reading the pay before HRMS.
//
// Every test works on a person of its own. The page's bulk "records start" act dates EVERYBODY without a date,
// so it is not exercised here (test/trackedFrom.test.ts pins it); each person gets their date on their own
// record instead, which is the per-person path.
//
// PAY BEFORE HRMS ALWAYS RUNS THROUGH APRIL of the current financial year, never later. A payroll build refuses
// any run whose month such an entry reaches, for everybody in the run - and these throwaway people are in every
// run another spec builds while they exist. April of the current year is a month no other spec builds (they
// use 2022-2025, the 2030s, and the current month for the quick run), so the refusal stays this file's.

const DAY = 86_400_000;

/** The financial year running today ("2026-27") and its first month ("2026-04"). */
function currentFy(): { label: string; april: string; aprilStart: string; aprilEnd: string } {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { label: `${y}-${String((y + 1) % 100).padStart(2, "0")}`, april: `${y}-04`, aprilStart: `${y}-04-01`, aprilEnd: `${y}-04-30` };
}

/** A throwaway person who joined in 2023, with HRMS records starting on `tracked` (or not set). */
async function personWhoJoinedBefore(page: Page, tag: string, tracked: string | null) {
  const person = await makeThrowawayPerson(page, tag);
  const got = await page.request.get(`/v1/${person.path}`);
  const { etag } = (await got.json()) as { etag: string };
  const patched = await page.request.patch(`/v1/${person.path}`, {
    headers: { ...SPA_HEADERS, "If-Match": etag },
    data: { start_date: "2023-01-10", ...(tracked ? { tracked_from: tracked } : {}) },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  return person;
}

/** A paid leave type from the seed - one that holds a balance. */
async function paidLeaveType(page: Page): Promise<{ path: string; display_name: string }> {
  const res = await page.request.get("/v1/leave-types?max_page_size=100");
  const { results: types = [] } = (await res.json()) as { results?: { path: string; display_name?: string; paid?: boolean; disabled?: boolean }[] };
  const type = types.find((t) => t.display_name && t.paid !== false && !t.disabled);
  expect(type, "the seed has no paid leave type").toBeTruthy();
  return type as { path: string; display_name: string };
}

const post = async (page: Page, path: string, data: unknown) => {
  const res = await page.request.post(path, { headers: SPA_HEADERS, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

test("brings over a leave balance, leave history and the year's pay through the page", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const tracked = ymd(new Date(Date.now() - 10 * DAY));
  const person = await personWhoJoinedBefore(page, "Opening", tracked);
  try {
    const type = await paidLeaveType(page);
    await gotoRoute(page, "opening-balances", "Opening balances");

    // ---- Leave balance ----
    const leave = page.locator("div").filter({ has: page.getByLabel("Opening balances sheet") }).last();
    await leave.getByLabel("Opening balances sheet").fill(`Employee ID\tName\t${type.display_name}\n${person.email}\t${person.name}\t7.5`);
    await expect(leave.getByText("1 balance read from 1 of 1 line")).toBeVisible();
    await leave.getByRole("button", { name: "Preview" }).click();
    await expect(leave.getByRole("cell", { name: person.name })).toBeVisible({ timeout: 30_000 });
    await leave.getByRole("button", { name: "Apply 1 balance" }).click();
    const confirmLeave = page.getByRole("dialog");
    await expect(confirmLeave.getByText("Apply these opening balances?")).toBeVisible();
    await confirmLeave.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(leave.getByText("1 applied")).toBeVisible({ timeout: 30_000 });

    const balRes = await page.request.get(`/v1/leave-balances?employee=${encodeURIComponent(person.path)}`);
    const { results: balances = [] } = (await balRes.json()) as { results?: { leave_type?: string; balance_days?: number }[] };
    expect(balances.find((b) => b.leave_type === type.path)?.balance_days).toBe(7.5);
    const adjRes = await page.request.get(`/v1/leave-adjustments?employee=${encodeURIComponent(person.path)}`);
    const { results: adjustments = [] } = (await adjRes.json()) as { results?: { kind?: string; opening_days?: number; as_of?: string }[] };
    expect(adjustments).toEqual([expect.objectContaining({ kind: "opening", opening_days: 7.5, as_of: tracked })]);

    // ---- Leave from before HRMS: history leaves the balance alone, booked leave takes its days off once ----
    const history = page.locator("div").filter({ has: page.getByLabel("Leave before HRMS sheet") }).last();
    const dmy = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    const bookedFrom = new Date(Date.now() + 20 * DAY);
    const bookedTo = new Date(Date.now() + 21 * DAY);
    await history.getByLabel("Leave before HRMS sheet").fill([
      "Employee ID\tLeave type\tFrom\tTo\tDays",
      `${person.email}\t${type.display_name}\t03/03/2025\t04/03/2025\t2`,
      `${person.email}\t${type.display_name}\t${dmy(bookedFrom)}\t${dmy(bookedTo)}\t2`,
    ].join("\n"));
    await history.getByRole("button", { name: "Preview" }).click();
    await expect(history.getByText("history - balance unchanged")).toBeVisible({ timeout: 30_000 });
    await expect(history.getByText("booked - takes the days off the balance")).toBeVisible();
    await history.getByRole("button", { name: "Bring in 2 leaves" }).click();
    const confirmHistory = page.getByRole("dialog");
    await expect(confirmHistory.getByText("Bring in this leave?")).toBeVisible();
    await confirmHistory.getByRole("button", { name: "Bring it in", exact: true }).click();
    await expect(history.getByText("2 brought in")).toBeVisible({ timeout: 30_000 });

    const lrRes = await page.request.get(`/v1/leave-requests?employee=${encodeURIComponent(person.path)}`);
    const { results: requests = [] } = (await lrRes.json()) as { results?: { state?: string; source?: string; days?: number; start_date?: string }[] };
    expect([...requests].sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""))).toEqual([
      expect.objectContaining({ state: "APPROVED", source: "import", days: 2, start_date: "2025-03-03" }),
      expect.objectContaining({ state: "APPROVED", source: "app", days: 2, start_date: ymd(bookedFrom) }),
    ]);
    const balAfter = await page.request.get(`/v1/leave-balances?employee=${encodeURIComponent(person.path)}`);
    const { results: after = [] } = (await balAfter.json()) as { results?: { leave_type?: string; balance_days?: number }[] };
    expect(after.find((b) => b.leave_type === type.path)?.balance_days).toBe(5.5);

    // ---- Pay and tax so far ----
    const pay = page.locator("div").filter({ has: page.getByLabel("Pay and tax so far sheet") }).last();
    const { april } = currentFy();
    await pay.getByLabel("Pay and tax so far sheet").fill(`Employee ID\tPaid through\tGross\tTDS\n${person.email}\t${april}\t100000\t2500`);
    await pay.getByRole("button", { name: "Preview" }).click();
    await expect(pay.getByRole("cell", { name: person.name })).toBeVisible({ timeout: 30_000 });
    await pay.getByRole("button", { name: "Apply for 1 person" }).click();
    const confirmPay = page.getByRole("dialog");
    await expect(confirmPay.getByText("Apply this pay and tax?")).toBeVisible();
    await confirmPay.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(pay.getByText("1 applied")).toBeVisible({ timeout: 30_000 });

    const openRes = await page.request.get(`/v1/payroll-openings?employee=${encodeURIComponent(person.path)}`);
    const { results: openings = [] } = (await openRes.json()) as { results?: { paid_through?: string; taxable_gross?: number; tds?: number }[] };
    expect(openings).toEqual([expect.objectContaining({ paid_through: april, taxable_gross: 100000, tds: 2500 })]);

    // The saved entry is listed under the section and taken back out from there.
    const savedRow = pay.getByRole("row").filter({ hasText: person.name }).filter({ has: page.getByRole("button", { name: "Remove" }) });
    await savedRow.getByRole("button", { name: "Remove" }).click();
    const confirmRemove = page.getByRole("dialog");
    await expect(confirmRemove.getByText("Remove this pay before HRMS?")).toBeVisible();
    await confirmRemove.getByRole("button", { name: "Remove", exact: true }).click();
    // The toast, not the row: while the confirm is closing the page behind it is still aria-hidden, so "the row
    // is gone" can read true before the delete has landed.
    await expect(toast(page, "Removed")).toBeVisible({ timeout: 30_000 });
    await expect(savedRow).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => {
      const gone = await page.request.get(`/v1/payroll-openings?employee=${encodeURIComponent(person.path)}`);
      return ((await gone.json()) as { results?: unknown[] }).results?.length ?? 0;
    }, { timeout: 15_000 }).toBe(0);
  } finally {
    await retireThrowawayPerson(page, person.path);
  }
});

test("the records-start date is set on the employee record, and the days before it stop reading as absences", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const person = await personWhoJoinedBefore(page, "Tracked", null);
  try {
    await gotoRoute(page, person.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });

    // Last month, before any date is set: joined in 2023 and no punches, so its working days are absences.
    const openLastMonth = async () => {
      await page.getByRole("tab", { name: "Attendance" }).click();
      const panel = page.getByRole("tabpanel");
      const views = panel.getByRole("group", { name: "History view" });
      await expect(views).toBeVisible({ timeout: 30_000 });
      const list = views.getByRole("button", { name: "List" });
      if ((await list.getAttribute("aria-pressed")) !== "true") await list.click();
      await panel.getByRole("button", { name: "Previous month" }).click();
      return panel;
    };
    let panel = await openLastMonth();
    await expect(panel.getByText("fix with a correction")).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Before HRMS")).toHaveCount(0);

    // The date goes in on the Employment card's edit form, and the card then states it.
    await page.getByRole("tab", { name: "Employment" }).click();
    await page.getByRole("tabpanel").getByRole("button", { name: "Edit" }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Edit employment" })).toBeVisible();
    const tracked = ymd(new Date(Date.now() - DAY));
    await form.getByLabel("HRMS records start").fill(tracked);
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("tabpanel").getByText("HRMS records start")).toBeVisible({ timeout: 30_000 });
    const saved = (await (await page.request.get(`/v1/${person.path}`)).json()) as { tracked_from?: string };
    expect(saved.tracked_from).toBe(tracked);

    // Last month again: the same empty days now read "Before HRMS", and none of them is an absence.
    panel = await openLastMonth();
    await expect(panel.getByText("Before HRMS").first()).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("none missed")).toBeVisible();
  } finally {
    await retireThrowawayPerson(page, person.path);
  }
});

test("the leave page shows a brought-over balance, HR's adjustment, and imported leave only HR can remove", async ({ as }) => {
  test.setTimeout(180_000);
  const hr = await as("super");
  const person = await personWhoJoinedBefore(hr, "LeaveOpen", ymd(new Date(Date.now() - DAY)));
  const subject = await userPath(hr, person.email);
  const reason = `e2e correction ${Date.now() % 100_000}`;
  // Leave-request search matches the reason and state, not the person, so the imported leave carries a word of
  // its own for HR to find it by.
  const marker = `bhrms${test.info().parallelIndex}${Date.now() % 1_000_000}`;
  try {
    const type = await paidLeaveType(hr);
    await post(hr, "/v1/leave-adjustments:importOpenings", { items: [{ employee: person.path, leave_type: type.path, opening_days: 6 }], dry_run: false });
    await post(hr, "/v1/leave-requests:importHistory", {
      items: [{ employee: person.path, leave_type: type.path, start_date: "2025-03-03", end_date: "2025-03-04", days: 2, reason: marker }],
      dry_run: false,
    });
    // The ledger is private by default; the runbook's grant lets a person read their own rows. Two rules, the
    // pair the Access screen writes for a row-scoped read (AclModal.tsx): `self` reaches the person's own rows,
    // and the bare collection rule reaches the list call those rows are read through.
    await post(hr, "/v1/access-rules", { subject_kind: "user", subject, collection: "leave-adjustments", scope: "self", level: "read", effect: "allow" });
    await post(hr, "/v1/access-rules", { subject_kind: "user", subject, collection: "leave-adjustments", scope: "create", level: "read", effect: "allow" });

    // ---- HR adjusts the balance by hand ----
    await gotoRoute(hr, "leave-requests", "Leaves");
    await hr.getByRole("tab", { name: /^Team balances/ }).click();
    // Newest balances first, so a person made a moment ago is on the first page.
    const balanceRow = hr.getByRole("row").filter({ hasText: person.name }).filter({ hasText: type.display_name });
    await balanceRow.getByRole("button", { name: "Adjust" }).click();
    const adjust = hr.getByRole("dialog");
    await expect(adjust.getByRole("heading", { name: `Adjust ${type.display_name} for ${person.name}` })).toBeVisible();
    await adjust.getByLabel("Days").fill("1.5");
    await expect(adjust.getByText("Balance becomes 7.5 (it is 6).")).toBeVisible();
    await adjust.getByLabel("Reason").fill(reason);
    await adjust.getByRole("button", { name: "Save adjustment" }).click();
    await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // ---- The person reads where their balance came from ----
    const them = await as({ email: person.email });
    await gotoRoute(them, "leave-requests", "Leaves");
    await them.getByRole("button", { name: "History", exact: true }).first().click();
    const sheet = them.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: `${type.display_name} history` })).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByText("Brought over from before HRMS")).toBeVisible();
    await expect(sheet.getByText(`Adjusted by HR: ${reason}`)).toBeVisible();
    // The imported leave never moved the balance, so it is not in the history.
    await expect(sheet.getByText(/^Requested /)).toHaveCount(0);
    await them.keyboard.press("Escape");
    await expect(them.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // ---- Their imported leave: marked, and not theirs to cancel ----
    await them.getByRole("tab", { name: /^History/ }).click();
    // A row opens its detail on click, so it is exposed as a button named by its cells.
    const theirHistory = them.getByRole("tabpanel");
    const theirRow = theirHistory.getByRole("button", { name: /Before HRMS/ });
    await expect(theirRow).toHaveCount(1, { timeout: 30_000 });
    await expect(theirRow.getByRole("button", { name: /Cancel|Remove|Move/ })).toHaveCount(0);

    // ---- HR takes it back out, and nothing is refunded ----
    await hr.getByRole("tab", { name: /^History/ }).click();
    await hr.getByPlaceholder("Search all records…").fill(marker);
    const hrRow = hr.getByRole("tabpanel").getByRole("button", { name: /Before HRMS/ }).filter({ hasText: person.name });
    await hrRow.getByRole("button", { name: "Remove", exact: true }).click();
    const confirmRemove = hr.getByRole("dialog");
    await expect(confirmRemove.getByText("Remove this leave from before HRMS?")).toBeVisible();
    await confirmRemove.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toast(hr, "Imported leave removed")).toBeVisible({ timeout: 30_000 });

    const lr = (await (await hr.request.get(`/v1/leave-requests?employee=${encodeURIComponent(person.path)}`)).json()) as { results?: { state?: string }[] };
    expect(lr.results?.map((r) => r.state)).toEqual(["CANCELLED"]);
    const bal = (await (await hr.request.get(`/v1/leave-balances?employee=${encodeURIComponent(person.path)}`)).json()) as { results?: { leave_type?: string; balance_days?: number }[] };
    expect(bal.results?.find((b) => b.leave_type === type.path)?.balance_days).toBe(7.5);
  } finally {
    const rules = (await (await hr.request.get("/v1/access-rules?page_size=500")).json()) as { results?: { path: string; subject?: string }[] };
    for (const r of rules.results ?? []) {
      if (r.subject === subject) await hr.request.delete(`/v1/${r.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
    await retireThrowawayPerson(hr, person.path);
  }
});

test("the Tax page counts the pay before HRMS, and payroll will not pay a month it covers again", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  // The refused build is logged by the browser as a 409 on the build call; it is the behaviour under test.
  allowConsoleErrors(page, /status of 409/i);
  const fy = currentFy();
  const person = await personWhoJoinedBefore(page, "PayOpen", ymd(new Date(Date.now() - DAY)));
  let openingPath: string | undefined;
  let runPath: string | undefined;
  try {
    const opening = (await post(page, "/v1/payroll-openings", {
      employee: person.path, financial_year: fy.label, paid_through: fy.april, gross: 150000, taxable_gross: 150000, tds: 12000, pt: 200,
    })) as { path: string };
    openingPath = opening.path;

    // ---- The Tax page names what was paid and deducted before HRMS ----
    await gotoRoute(page, person.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Compensation" }).click();
    const panel = page.getByRole("tabpanel");
    // The tax card opens on request: reading somebody's projection is an audited act.
    await panel.getByRole("button", { name: "Show" }).click();
    // Grouping follows the org's number format (150,000 or 1,50,000), so the digits are matched either way.
    await expect(panel.getByText(/Includes \D*1,?50,?000 paid before HRMS \(through Apr \d{4}\)/)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/Includes \D*12,?000 deducted before HRMS/)).toBeVisible();

    // ---- A payroll run for April is refused, naming the person ----
    const periods = (await (await page.request.get("/v1/pay-periods?page_size=200")).json()) as { results?: { path: string; period_start?: string; display_name?: string }[] };
    let period = (periods.results ?? []).find((p) => p.period_start === fy.aprilStart);
    if (!period) {
      period = (await post(page, "/v1/pay-periods", {
        display_name: `E2E before HRMS ${fy.april}`, period_start: fy.aprilStart, period_end: fy.aprilEnd, pay_date: fy.aprilEnd,
      })) as { path: string; display_name?: string };
    }
    const made = await page.request.post("/v1/payroll-runs", { headers: SPA_HEADERS, data: { pay_period: period.path } });
    expect(made.status(), await made.text()).toBe(200);
    runPath = ((await made.json()) as { path: string }).path;

    await gotoRoute(page, "payroll-runs", "Payroll");
    const row = page.locator("tbody tr").filter({ hasText: period.display_name ?? fy.april }).filter({ hasText: /Draft/i }).first();
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Build" }).click();
    // The server's own reason, not "somebody else changed this run": re-reading cannot fix this one.
    // Case-insensitive: the page prints the server's detail as a sentence ("Pay before HRMS ...").
    await expect(toast(page, /pay before HRMS already covers/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(new RegExp(`already covers ${fy.april} for .*${person.name.split(" ").pop()}`))).toBeVisible();

    const items = (await (await page.request.get(`/v1/${runPath}/items`)).json()) as { results?: unknown[] };
    expect(items.results ?? [], "a refused build must write nothing").toHaveLength(0);
  } finally {
    if (runPath) {
      const got = await page.request.get(`/v1/${runPath}`);
      if (got.ok()) {
        const { etag } = (await got.json()) as { etag: string };
        await page.request.delete(`/v1/${runPath}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
      }
    }
    if (openingPath) {
      const got = await page.request.get(`/v1/${openingPath}`);
      if (got.ok()) {
        const { etag } = (await got.json()) as { etag: string };
        await page.request.delete(`/v1/${openingPath}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
      }
    }
    await retireThrowawayPerson(page, person.path);
  }
});
