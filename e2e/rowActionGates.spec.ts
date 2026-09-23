import {
  SPA_HEADERS,
  gotoRoute,
  personPath,
  purge,
  test,
  expect,
} from "./fixtures";

// Two cards on one board, one reader, two different answers.
//
// Collection-level gating decides which pages open (`navMatrix`) and which create buttons exist
// (`createGates`). Neither says anything about the finest gate in the app: the per-ROW one. Every row the
// server sends carries `access.can` - the verbs THIS caller may use on THAT object - and the UI is built to
// obey it in one place (`RowActions` drops any action whose verb is missing, and the board's own cards ask
// `can.includes("update")` before drawing a pencil). The failure it prevents is small on screen and large in
// practice: an edit button on somebody else's post, whose only possible outcome is a 403 and whose presence
// tells the reader they are allowed to rewrite it.
//
// The board is where this is sharpest, because the two cards sit side by side for the SAME reader: everyone
// may read every post, an author may edit their own (`announcements.me.**`), and nobody may edit anybody
// else's. That is one page, one viewer, one screenshot's worth of difference - and no server test can see
// it, because the server's answer to both is a correct `can` list.
test("the board offers an author their own card's actions and not a colleague's", async ({ as }) => {
  test.setTimeout(300_000);
  const hr = await as("hr");
  const employee = await as("employee");
  // Only super may hard-purge, so the tidying up at the end is done as them.
  const admin = await as("super");
  const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
  const theirs = `E2E row-gate HR post ${stamp}`;
  const mine = `E2E row-gate kudos ${stamp}`;
  let hrPost = "";
  let kudo = "";

  try {
    // HR's post: the employee may read it and nothing else.
    const posted = await hr.request.post("/v1/announcements", {
      headers: SPA_HEADERS,
      data: { title: theirs, body: "Posted by HR for the row-gate spec.", audience_scope: "none" },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    hrPost = ((await posted.json()) as { path: string }).path;

    // The employee's own card: kudos is the one board post an ordinary person may author, and the giver owns
    // it - which is what makes the pair a contrast rather than two negatives.
    const recipient = await personPath(hr, "hr");
    const given = await employee.request.post("/v1/announcements:giveKudos", {
      headers: SPA_HEADERS,
      data: { recipient, message: mine },
    });
    expect(given.status(), await given.text()).toBe(200);
    kudo = ((await given.json()) as { path: string }).path;

    await gotoRoute(employee, "announcements", "Feed");

    // Both cards are on the reader's board - the row gate is about the ACTIONS, not about visibility.
    const colleagues = employee.locator("div.shadow-card").filter({ hasText: theirs }).first();
    const own = employee.locator("div.shadow-card").filter({ hasText: mine }).first();
    await expect(colleagues).toBeVisible({ timeout: 30_000 });
    await expect(own).toBeVisible({ timeout: 30_000 });

    // Their own card carries the author's affordances…
    await expect(own.getByRole("button", { name: "Edit" }), "an author was not offered their own card's edit").toBeVisible();
    await expect(own.getByRole("button", { name: "Delete" })).toBeVisible();

    // …and the colleague's carries none of them.
    await expect(colleagues.getByRole("button", { name: "Edit" }), "a reader was offered edit on somebody else's post").toHaveCount(0);
    await expect(colleagues.getByRole("button", { name: "Delete" }), "a reader was offered delete on somebody else's post").toHaveCount(0);

    // The server agrees, which is what the UI was reading: the hint on the row it refuses to act on says so.
    const listed = await employee.request.get("/v1/announcements?page_size=100");
    expect(listed.status(), await listed.text()).toBe(200);
    const rows = ((await listed.json()) as { results?: { path: string; title?: string; access?: { can?: string[] } }[] }).results ?? [];
    const hint = (path: string) => rows.find((r) => r.path === path)?.access?.can ?? [];
    expect(hint(kudo), "the author's own row should offer update").toContain("update");
    expect(hint(hrPost), "a colleague's row should not offer update").not.toContain("update");

    // And the refusal is real, not decorative: asking for the edit by path is refused.
    const got = await employee.request.get(`/v1/${hrPost}`);
    const etag = got.ok() ? ((await got.json()) as { etag?: string }).etag : undefined;
    const edited = await employee.request.patch(`/v1/${hrPost}`, {
      headers: { ...SPA_HEADERS, ...(etag ? { "If-Match": etag } : {}) },
      data: { title: `${theirs} (rewritten)` },
    });
    expect(edited.status(), "an employee could rewrite a colleague's post").toBe(403);
  } finally {
    if (kudo) await purge(admin, kudo);
    if (hrPost) await purge(admin, hrPost);
  }
});
