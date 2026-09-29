import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// Board access on the real stack: a board's department decides which managers manage it, and its visibility and
// sharing list decide who sees and works it (domain/boardAccess.ts, services/boardShares.ts).
// `test/boardAccess.test.ts` decides every level against stored rules; this is what the seeded logins meet.
//
// The seed: mgr@example.com heads Engineering (emp@example.com works there), pm@example.com is the project
// manager and manages every board.

type Board = { path: string; etag: string; visibility?: string; my_access?: string };

test("a manager files a board under their own department, and a private board is shown only to whom it is shared with", async ({ as }) => {
  test.setTimeout(180_000);
  const manager = await as("manager");
  const pm = await as("pm");
  const employee = await as("employee");
  const admin = await as("super"); // the hard purges are an admin's to make
  const stamp = Date.now();
  const made: string[] = [];

  const depts = await admin.request.get("/v1/departments?max_page_size=100");
  expect(depts.status(), await depts.text()).toBe(200);
  const { results = [] } = (await depts.json()) as { results?: { path: string; display_name: string }[] };
  const engineering = results.find((d) => d.display_name === "Engineering")!.path;
  const sales = results.find((d) => d.display_name === "Sales")!.path;

  try {
    // ---- A manager's board: one of their departments, required; somebody else's, refused.
    expect((await manager.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E no dept ${stamp}` } })).status()).toBe(400);
    expect((await manager.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E sales ${stamp}`, department: sales } })).status()).toBe(403);
    const mine = await manager.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E eng ${stamp}`, department: engineering } });
    expect(mine.status(), await mine.text()).toBe(200);
    const engBoard = (await mine.json()) as Board;
    made.push(engBoard.path);
    expect(engBoard.my_access).toBe("manage");
    expect(engBoard.visibility).toBe("edit");
    expect((await manager.request.post(`/v1/${engBoard.path}:configure`, { headers: SPA_HEADERS, data: { hide_empty_lanes: true } })).status()).toBe(200);

    // ---- A private Sales board: invisible to an Engineering employee and to the Engineering manager.
    const secret = await pm.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E private ${stamp}`, department: sales, visibility: "private" } });
    expect(secret.status(), await secret.text()).toBe(200);
    const board = (await secret.json()) as Board;
    made.unshift(board.path);
    for (const who of [employee, manager]) expect([403, 404]).toContain((await who.request.get(`/v1/${board.path}`)).status());

    // Shared with the employee to view: they see it, and cannot file a task on it.
    const shared = await pm.request.post(`/v1/${board.path}:share`, {
      headers: SPA_HEADERS,
      data: { members: [{ kind: "user", subject: await personPath(pm, "employee"), level: "view" }] },
    });
    expect(shared.status(), await shared.text()).toBe(200);
    const seen = await employee.request.get(`/v1/${board.path}`);
    expect(seen.status(), await seen.text()).toBe(200);
    expect(((await seen.json()) as Board).my_access).toBe("view");
    expect((await employee.request.post("/v1/cards", { headers: SPA_HEADERS, data: { title: `E2E refused ${stamp}`, board: board.path } })).status()).toBe(403);

    // The page hides what a viewer cannot do: no add-task control on the board.
    const boardId = board.path.split("/")[1]!;
    await gotoRoute(employee, `boards?board=${boardId}`, "Boards");
    await expect(employee.getByRole("button", { name: /^Add a task to / }).first()).toBeHidden({ timeout: 30_000 });
    await expect(employee.getByText("Backlog").first()).toBeVisible({ timeout: 30_000 });

    // The project manager sees the list in the board's Sharing tab.
    await pm.goto(`/boards?board=${boardId}&setting=board-config&settingObj=boards/${boardId}`);
    const sharingTab = pm.getByRole("tab", { name: "Sharing" });
    await expect(sharingTab).toBeVisible({ timeout: 30_000 });
    await sharingTab.click();
    await expect(pm.getByText("Eve Employee")).toBeVisible({ timeout: 30_000 });
    await expect(pm.getByRole("combobox", { name: "What Eve Employee can do" })).toBeVisible();
  } finally {
    for (const path of made) await purge(admin, path);
  }
});
