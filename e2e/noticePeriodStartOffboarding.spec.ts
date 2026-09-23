import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Recording a notice period can ALSO kick off the leaver's offboarding in the same save (the "Start
// offboarding" checkbox, create-only) - `noticePeriodDates.spec.ts` covers the form's date arithmetic but
// never checks this box, so the actual link it creates (a real `transitions` row, anchored to the last
// working day) has never been proven. src/services/noticePeriods.ts creates it best-effort and links it back
// onto the notice period; this is the one thing only a browser can show landing correctly end to end.
test("checking Start offboarding when recording a notice creates and links a real offboarding transition", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const first = "E2eNotice";
  const last = `Leaver${stamp}`;
  const fullName = `${first} ${last}`;

  const madeEmp = await page.request.post("/v1/employees", {
    headers: SPA_HEADERS,
    data: { first_name: first, last_name: last, work_email: `e2e.notice.${stamp}@example.com` },
  });
  expect(madeEmp.status(), await madeEmp.text()).toBe(200);
  const employee = (await madeEmp.json()) as { path: string };

  let noticePath: string | undefined;
  let transitionPath: string | undefined;
  try {
    await gotoRoute(page, "notice-periods", "Notice Periods");
    await page.getByRole("button", { name: "Record notice" }).first().click();
    const form = page.getByRole("dialog");

    await form.getByLabel("Employee").click();
    await page.getByPlaceholder(/Search|Select/).last().fill(fullName);
    await expect(page.getByRole("option", { name: new RegExp(fullName) })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Enter");

    const noticeDate = await form.getByLabel("Notice given").inputValue();
    const lwd = addDays(noticeDate, 10);
    await form.getByLabel("Last working day").fill(lwd);

    await form.getByLabel("Start offboarding").check();
    const submit = form.getByRole("button", { name: "Record", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(toast(page, "Notice recorded · offboarding started")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    // The row itself carries the "offboarding under way" marker (an icon by the name, per the collection's
    // own list rendering) rather than looking like a plain notice.
    const row = page.locator("tbody tr").filter({ hasText: fullName }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('[aria-label="Offboarding started"]')).toBeVisible();

    // The link, on the wire: a real transitions row, anchored to the last working day just picked.
    const notices = await page.request.get("/v1/notice-periods?page_size=200");
    expect(notices.status(), await notices.text()).toBe(200);
    const { results: allNotices = [] } = (await notices.json()) as { results?: { path: string; employee?: string; transition?: string }[] };
    const notice = allNotices.find((n) => n.employee === employee.path);
    expect(notice?.transition, "the notice never linked back to an offboarding transition").toBeTruthy();
    noticePath = notice!.path;
    transitionPath = notice!.transition!;

    const tr = await page.request.get(`/v1/${transitionPath}`);
    expect(tr.status(), await tr.text()).toBe(200);
    const transition = (await tr.json()) as { kind?: string; employee?: string; anchor_date?: string };
    expect(transition.kind).toBe("offboarding");
    expect(transition.employee).toBe(employee.path);
    expect(transition.anchor_date).toBe(lwd);
  } finally {
    // The notice references the transition, not the other way round - drop that reference first so the
    // transition isn't an FK a purge has to work around.
    if (noticePath) await purge(page, noticePath);
    if (transitionPath) await purge(page, transitionPath);
    await purge(page, employee.path);
  }
});

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
