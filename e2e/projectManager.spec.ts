import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// The seeded project manager (bootstrap/authz/roles/project_manager.json): runs boards and sprints, and the
// goals of the people who report to them - and nothing a department manager decides.
//
// `test/roleFiles.test.ts` decides every one of these paths against the role file. What it cannot show is that
// the rows the seed writes for the role are the ones that decide on a real server, or that `my-reports`
// resolves off the live reporting line: pm@example.com is the seeded Product department head
// (scripts/genSeed.ts), so the Product department reports to them and nobody in Engineering does.
test("the project manager runs boards and sprints and sets a report's goals, and no one else's", async ({ as }) => {
  test.setTimeout(180_000);
  const pm = await as("pm");
  const employee = await as("employee");
  const admin = await as("super"); // the hard purges are an admin's to make
  const stamp = Date.now();
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const made: string[] = [];

  try {
    // ---- Boards and sprints: the PM makes the board a team plans on; a plain employee only works its cards.
    expect((await employee.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E PM denied ${stamp}` } })).status()).toBe(403);
    const boardRes = await pm.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E PM board ${stamp}`, mode: "scrum" } });
    expect(boardRes.status(), await boardRes.text()).toBe(200);
    const board = ((await boardRes.json()) as { path: string }).path;
    made.push(board);

    const sprintRes = await pm.request.post("/v1/sprints", { headers: SPA_HEADERS, data: { board, name: `E2E PM sprint ${stamp % 100000}`, start_date: day(0), end_date: day(13) } });
    expect(sprintRes.status(), await sprintRes.text()).toBe(200);
    const sprint = (await sprintRes.json()) as { path: string; etag: string };
    made.unshift(sprint.path);
    const started = await pm.request.post(`/v1/${sprint.path}:activate`, { headers: { ...SPA_HEADERS, "If-Match": sprint.etag } });
    expect(started.status(), await started.text()).toBe(200);

    // ---- Goals: a direct report's, set by the PM; a colleague outside the reporting line's, refused.
    const pmPath = await personPath(pm, "pm");
    let report: { path: string } | undefined;
    let token = "";
    do {
      const people = await pm.request.get(`/v1/employees?max_page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
      expect(people.status(), await people.text()).toBe(200);
      const body = (await people.json()) as { results?: { path: string; manager?: string | null }[]; next_page_token?: string };
      report = (body.results ?? []).find((e) => e.manager === pmPath);
      token = body.next_page_token ?? "";
    } while (!report && token);
    expect(report, "the seed gives pm@example.com direct reports").toBeDefined();

    const goalTitle = `E2E PM report goal ${stamp % 1_000_000}`;
    const goalRes = await pm.request.post("/v1/goals", { headers: SPA_HEADERS, data: { title: goalTitle, employee: report!.path, due_date: day(30) } });
    expect(goalRes.status(), await goalRes.text()).toBe(200);
    const goal = ((await goalRes.json()) as { path: string }).path;
    made.unshift(goal);
    const commented = await pm.request.post(`/v1/${goal}:comment`, { headers: SPA_HEADERS, data: { body: "E2E coaching note" } });
    expect(commented.status(), await commented.text()).toBe(200);

    const outsider = await personPath(pm, "employee"); // Engineering, reporting to mgr@example.com
    const refused = await pm.request.post("/v1/goals", { headers: SPA_HEADERS, data: { title: `E2E PM outsider goal ${stamp}`, employee: outsider, due_date: day(30) } });
    expect(refused.status(), await refused.text()).toBe(403);

    // ---- Not a team lead: a report's 1:1 is not the PM's to write.
    const checkIn = await pm.request.post("/v1/check-ins", { headers: SPA_HEADERS, data: { employee: report!.path, counterpart: pmPath, meeting_date: day(-1), notes: `E2E PM check-in ${stamp}` } });
    if (checkIn.status() === 200) made.unshift(((await checkIn.json()) as { path: string }).path);
    expect(checkIn.status(), await checkIn.text()).toBe(403);

    // ---- The Team goals page is theirs, and shows the report's goal.
    await gotoRoute(pm, "team-goals", "Team goals");
    await expect(pm.getByText(goalTitle).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    for (const path of made) await purge(admin, path);
  }
});
