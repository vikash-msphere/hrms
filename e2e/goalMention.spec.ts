import { SPA_HEADERS, gotoRoute, personId, purge, test, expect } from "./fixtures";

// Naming somebody in a goal's thread.
//
// `test/goalMentions.test.ts` owns the notify fan-out and the link a mention points at; `e2e/mentions.spec.ts`
// owns the caret mechanics of the picker itself, on the board. What is left, and is browser-only, is that the
// GOAL drawer's comment box is one of the boxes that offers it at all - and that the thread renders the token
// as a chip rather than as the raw markdown the server has been notifying people from since goal comments
// existed. Those two were the whole gap: the notification half worked, and there was no way to author one.
test("a goal comment offers the mention picker, posts a chip, and reaches the person named", async ({ as }) => {
  test.setTimeout(180_000);
  const manager = await as("manager");
  const named = await as("employee");
  const admin = await as("super"); // the hard purge is an admin's to make
  const stamp = Date.now();
  const title = `E2E goal mention ${stamp}`;
  const employeeId = await personId(manager, "employee");

  // The goal is written over the wire - composing one is `goals.spec.ts`'s subject - and owned by the person
  // who will be mentioned, so the manager commenting on it is the ordinary path.
  const created = await manager.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { title, description: "Raised by the goal mention spec.", employee: `employees/${employeeId}` },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;
  const id = path.split("/")[1]!;

  try {
    await gotoRoute(manager, `goals/${id}`);
    const detail = manager.getByRole("dialog");
    await expect(detail.getByText(title).first()).toBeVisible({ timeout: 30_000 });

    const box = detail.getByPlaceholder(/^Add a comment/);
    await expect(box).toBeVisible();
    // Scoped to the box's own container, which is what the menu is anchored inside. The drawer names the
    // goal's owner elsewhere - on the line under the title, which links to their profile - so "the button
    // called Eve Employee" is two different controls on this surface.
    // `has:` takes a locator matched from the element being filtered, so it is built off the page rather than
    // chained through the dialog - a chained one would look for the whole dialog inside this div and match
    // nothing.
    const menu = detail.locator("div.relative").filter({ has: manager.getByPlaceholder(/^Add a comment/) });
    await box.click();
    // Typed, not filled: the run being completed is read off the caret, so the offer only exists while the
    // keystrokes actually land in the field.
    await box.pressSequentially("Over to @Ev");
    await expect(menu.getByRole("button", { name: /Eve Employee/ })).toBeVisible({ timeout: 30_000 });

    // Enter takes the highlighted row. The menu gets first refusal on the key, so this must not post the
    // comment (Cmd+Enter does that) or type a newline.
    await box.press("Enter");
    await expect(menu.getByRole("button", { name: /Eve Employee/ })).toHaveCount(0);
    // The pick writes the NAME into the box; the wire id it binds rides beside the draft and goes back into
    // the text on submit (web/src/lib/mentionText.ts).
    await expect(box).toHaveValue("Over to @Eve Employee ");

    // The stamp rides in the body: this seeded person's bell is shared by dozens of specs, and the excerpt is
    // how this mention is told from theirs.
    await box.pressSequentially(`- what is the number? ${stamp}`);
    await detail.getByRole("button", { name: "Post", exact: true }).click();

    // In the thread the token is a chip that links to the person - and the raw markdown is nowhere on screen.
    const chip = detail.getByRole("link", { name: "@Eve Employee" });
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveAttribute("href", `/employees/${employeeId}`);
    await expect(detail.getByText("](employees/")).toHaveCount(0);

    // And it reaches the person named, in their own notifications, pointing at the goal itself rather than at
    // the wall of everybody's goals. Asked of the record by subject, not of the newest row: under 16-worker
    // load this bell is busy with other specs' notifications.
    await expect
      .poll(async () => {
        const res = await named.request.get("/v1/notifications?page_size=100");
        if (!res.ok()) return false;
        const { results = [] } = (await res.json()) as { results?: { type?: string; subject?: string; link?: string }[] };
        const hit = results.find((n) => n.subject === path && n.type === "goal.mention");
        return !!hit && hit.link === path;
      }, { timeout: 60_000, message: "the mention never reached the named person's notifications" })
      .toBe(true);
  } finally {
    await purge(admin, path);
  }
});
