import {
  SPA_HEADERS,
  gotoRoute,
  makeThrowawayPerson,
  purge,
  retireThrowawayPerson,
  test,
  expect,
} from "./fixtures";

// A manager's queue is their own team's, and the refusal holds even when the UI is bypassed.
//
// Deciding is scoped: the seeded manager grant allows `overtime-requests.my-dept.approve`, never `*.approve`
// - "`*` here would let a manager decide ANY dept's request (cross-dept BOLA); `my-dept` keeps it owned"
// (src/domain/grants.ts). The Approvals hub is where that scope is either honoured or leaked, and it is a
// hub: one inbox pulling every queue this person can decide, built from a summary endpoint rather than from
// the pages the requests belong to. `leaveTwoRoles` proves a manager CAN decide their own report's request.
// Nobody has ever checked the other half - that somebody else's report is not in there, and that the verb is
// refused if the row is asked for by path anyway.
//
// The outsider is a person this spec provisions, with no department at all: nobody's report, so no manager's
// queue may carry them.
test("a manager's inbox holds their own team's requests, and the verb refuses anybody else's", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const outsider = await makeThrowawayPerson(admin, "Outsider");
  const theirs = await as({ email: outsider.email });
  const manager = await as("manager");
  const employee = await as("employee");

  const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
  const mine = `E2E dept overtime ${stamp}`;
  const alien = `E2E outsider overtime ${stamp}`;
  let minePath = "";
  let alienPath = "";

  try {
    // Two overtime requests, one from the manager's own report (the seed makes mgr@ Eve's manager) and one
    // from somebody outside every department.
    minePath = await fileOvertime(employee, mine);
    alienPath = await fileOvertime(theirs, alien);

    await gotoRoute(manager, "approvals", "Approvals");
    // Their report's request is here and decidable - which is what makes the absence below a scope rather
    // than an empty inbox or a queue that never loaded.
    await expect(manager.getByText(mine).first()).toBeVisible({ timeout: 30_000 });
    await expect(manager.getByText(alien), "a manager's inbox carried a request from outside their team").toHaveCount(0);

    // And the row is not reachable by path either: hiding it would be a UI courtesy, refusing it is the
    // access control.
    const read = await manager.request.get(`/v1/${alienPath}`);
    expect(read.status(), "a manager could read a request from outside their team").toBe(403);
    const decided = await manager.request.post(`/v1/${alienPath}:approve`, { headers: SPA_HEADERS });
    expect(decided.status(), "a manager could approve a request from outside their team").toBe(403);

    // It is still a real, decidable request - by somebody whose grant covers it org-wide.
    expect((await admin.request.get(`/v1/${alienPath}`)).status()).toBe(200);

    // The employee who filed it has no queue of their own at all: approving is nobody's self-service.
    await gotoRoute(employee, "approvals");
    await expect(employee.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  } finally {
    for (const path of [minePath, alienPath]) if (path) await purge(admin, path);
    await retireThrowawayPerson(admin, outsider.path);
  }
});

/**
 * File one overtime request as whoever this page is.
 *
 * Its own hour of its own far-future day: the seeded employee is asked for overtime by several specs at once,
 * and two requests for the same hours are the kind of collision that fails a spec for a reason that has
 * nothing to do with what it is testing.
 */
let filed = 0;
async function fileOvertime(page: import("@playwright/test").Page, reason: string): Promise<string> {
  const slot = test.info().parallelIndex * 4 + filed++;
  const on = new Date(Date.UTC(2028, 5, 1 + (slot % 100))).toISOString().slice(0, 10);
  const hour = String(6 + (slot % 12)).padStart(2, "0");
  const res = await page.request.post("/v1/overtime-requests", {
    headers: SPA_HEADERS,
    data: { start_time: `${on}T${hour}:00:00.000Z`, end_time: `${on}T${hour}:45:00.000Z`, reason },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}
