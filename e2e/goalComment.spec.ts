import { SPA_HEADERS, gotoRoute, personId, purge, test, expect } from "./fixtures";

// The conversation on somebody's goal.
//
// A goal is not only a number: the coaching happens in the comments under it, and they are what makes a
// quarter's progress reviewable months later. The thread is a sub-resource with its own verb, posted from a
// box on the goal's own detail dialog - so it is a write made inside an already-open dialog, and the thing
// that has to be true is that the comment appears in the thread the OTHER person opens, not just in the
// author's copy of the page.
//
// `goals` covers the progress slider and `goalTaskLink` the board tie-in. `test/goalAlignment.test.ts` owns
// the rollup. Nothing covers the thread, and the failure it guards against is quiet: a comment that posts and
// is never seen by the person it was written for.
test("a manager's comment on a goal reaches the person it belongs to", async ({ as }) => {
  test.setTimeout(180_000);
  const manager = await as("manager");
  const owner = await as("employee");
  const admin = await as("super"); // the hard purge is an admin's to make
  const stamp = Date.now() % 1_000_000;
  const title = `E2E coached goal ${stamp}`;
  const note = `Nicely ahead of the curve ${stamp}`;

  // Set for the report, over the wire: composing the goal is `goals`' subject, and this one starts once a
  // goal somebody else owns exists.
  const employeeId = await personId(manager, "employee");
  const created = await manager.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { title, description: "Raised by the comment spec.", employee: `employees/${employeeId}` },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;
  const id = path.split("/")[1]!;

  try {
    // Opened by its own deep link, which is how a goal is reached from a notification or a shared URL - and
    // which lands on the detail dialog rather than making this spec hunt a card down a filtered list.
    await gotoRoute(manager, `goals/${id}`);
    const detail = manager.getByRole("dialog");
    await expect(detail.getByText(title).first()).toBeVisible({ timeout: 30_000 });

    // The thread is on the drawer's Discussion tab; it opens on Overview.
    await detail.getByRole("tab", { name: /^Discussion/ }).click();
    // The box is the affordance; the button will not post an empty one.
    const box = detail.getByPlaceholder(/^Add a comment/);
    await expect(box).toBeVisible();
    const post = detail.getByRole("button", { name: "Post", exact: true });
    await expect(post).toBeDisabled();
    await box.fill(note);
    await expect(post).toBeEnabled();
    await post.click();

    // In the thread, attributed - a comment with no author is not a conversation. The thread's own row, not
    // the first "Mara Manager" in the drawer: the Overview tab names the manager too ("Agreed by …"), hidden
    // behind the tab this spec is on.
    await expect(detail.getByText(note)).toBeVisible({ timeout: 30_000 });
    await expect(detail.getByRole("listitem").filter({ hasText: note }).getByText("Mara Manager")).toBeVisible();

    // The half that matters: the person whose goal it is opens it in their own browser and reads it.
    await gotoRoute(owner, `goals/${id}`);
    const theirs = owner.getByRole("dialog");
    await expect(theirs.getByText(title).first()).toBeVisible({ timeout: 30_000 });
    await theirs.getByRole("tab", { name: /^Discussion/ }).click();
    await expect(theirs.getByText(note)).toBeVisible({ timeout: 30_000 });
  } finally {
    await purge(admin, path);
  }
});
