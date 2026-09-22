import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// The board's social machinery: a poll, a reaction, and a pin.
//
// All three are optimistic in the browser - the tally, the emoji chip and the order of the feed all move
// before the server answers, because a board where pressing something does nothing for 300ms feels broken.
// `test/boardEngagement.test.ts` and `test/announcement*` own the rows. What only a browser shows is the
// moving: a vote that redraws its own bar, a reaction chip that appears with a count of one, and a pin that
// lifts a post to the top of the feed under its own divider.
test.describe("the board", () => {
  test("a poll takes a vote and redraws its tally", async ({ as }) => {
    const author = await as("hr");
    const voter = await as("super");
    const question = `E2E poll ${Date.now()}`;

    // The poll itself is a create; the browser's business is the voting.
    const poll = await makePoll(author, question);

    await gotoRoute(voter, "announcements", "Feed");
    const card = voter.locator("div.shadow-card").filter({ hasText: question }).first();
    await expect(card).toBeVisible();

    // Nobody has voted yet.
    await expect(card).toContainText("0");
    await card.getByRole("button", { name: /^Yes/ }).first().click();

    // The bar and the tally are redrawn from the vote, on the card that was pressed.
    await expect(card).toContainText("100%");
    await expect(card.getByText("1", { exact: false }).first()).toBeVisible();

    // Pressing the same option again clears the vote - a poll you cannot change your mind in is a poll
    // people do not answer.
    await card.getByRole("button", { name: /^Yes/ }).first().click();
    await expect(card).not.toContainText("100%");

    await purge(author, poll);
  });

  test("a reaction and a pin both move the board", async ({ as }) => {
    const author = await as("hr");
    const reader = await as("super");
    const title = `E2E post ${Date.now()}`;

    const post = await makePost(author, title);

    await gotoRoute(reader, "announcements", "Feed");
    const card = reader.locator("div.shadow-card").filter({ hasText: title }).first();
    await expect(card).toBeVisible();

    // A reaction: the picker is how the first one is added, and the chip that appears carries the count.
    await card.getByRole("button", { name: "Add reaction" }).click();
    const picker = reader.getByRole("dialog").or(reader.locator("[data-radix-popper-content-wrapper]"));
    await picker.locator("button").first().click();
    await expect(card.locator("button").filter({ hasText: "1" }).first()).toBeVisible();

    // A pin lifts the post out of the timeline and under the "Pinned" divider - moderation that has to be
    // visible to mean anything.
    // PINNING NOW DISPLACES whatever is already pinned, which makes this spec share state with every other
    // spec that pins. The board is org-wide, the incumbent may belong to a test running beside this one,
    // and that test purges its post when it finishes - so the unpin this press issues can land on a post
    // that has just been deleted. The app treats a gone incumbent as already unpinned and carries on (see
    // `togglePin`), but the browser still logs the 404 it got, and this harness fails a test for any
    // console error. Excused by URL rather than by status, so it tolerates exactly that race and nothing
    // else.
    allowConsoleErrors(reader, /:unpin$/);
    await card.getByRole("button", { name: "Pin" }).click();
    // ...behind a confirmation, because pinning puts one post above everything for the whole company. The
    // dialog names the post it displaces when there is one, so its confirm button carries either label.
    await reader.getByRole("dialog").getByRole("button", { name: /^(Pin it|Unpin that, pin this)$/ }).click();
    await expect(reader.getByText("Pinned").first()).toBeVisible();
    await expect(reader.locator("div.shadow-card").filter({ hasText: title }).first()).toContainText(/Pinned/);

    await purge(author, post);
  });
});

/** A poll on the board, with two options. */
async function makePoll(page: import("@playwright/test").Page, question: string): Promise<string> {
  const res = await page.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title: question, kind: "poll", options: ["Yes, please", "No, thanks"], multiple: false },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** An ordinary board post. */
async function makePost(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title, body: "Raised by the board-social spec.", kind: "announcement" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}
