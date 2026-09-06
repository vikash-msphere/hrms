import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The votes that decide which suggestion anybody looks at.
//
// `suggestions.spec.ts` covers filing one anonymously and HR answering it. The ranking is the other half of
// the box working: a suggestion with no votes is a note in a drawer, and the votes are what put it in front
// of somebody. Voting is a press with no dialog and no save (`:upvote` / `:downvote`), the net score has to
// move under it, pressing the same arrow again takes the vote BACK (a vote is a stance, not a counter), and
// the score has to be the same number for the next reader - `test/suggestions.test.ts` owns the tallying, so
// what this pins is the loop between the arrow and the number.
test("a suggestion is voted up, the vote is taken back, and the score is what others see", async ({ as }) => {
  test.setTimeout(180_000);
  // The box is opened to the company by an ACL, not by a role grant: an org grants `suggestions:upvote` and
  // `:downvote` to the `everyone` pseudo-role, which is exactly what this spec sets up first - the seed
  // pre-grants that only for notifications. So the setup is part of the story: without it, nobody but the
  // submitter can move a score.
  const admin = await as("super");
  const author = await as("super");
  const voter = await as("employee");
  const reader = await as("hr");
  const rules = await openTheBox(admin);
  const title = `E2E votable ${Date.now() % 100000}`;

  const made = await author.request.post("/v1/suggestions", {
    headers: SPA_HEADERS,
    data: { title, body: "Filed by the e2e suite to be voted on.", anonymous: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  const suggestion = (await made.json()) as { path: string };

  await gotoRoute(voter, "suggestions", "Suggestion Box");
  // The card is the box that holds BOTH the title and the vote column - filtering on the title alone lands
  // on the text block inside it, which has no arrows.
  const card = voter.locator("div").filter({ hasText: title }).filter({ has: voter.getByTitle("Upvote") }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });

  // Up: one press, no dialog, and the number moves. The arrow is the write.
  await card.getByTitle("Upvote").click();
  await expect(card.getByText("1", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // Again: a vote is a stance, so pressing the same arrow withdraws it rather than adding a second one.
  await card.getByTitle("Upvote").click();
  await expect(card.getByText("0", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // Down: the same control in the other direction, and the net score goes negative.
  await card.getByTitle("Downvote").click();
  await expect(card.getByText("-1", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // And that is the score the next reader sees - the tally is the box's, not this browser's.
  await gotoRoute(reader, "suggestions", "Suggestion Box");
  const theirs = reader.locator("div").filter({ hasText: title }).filter({ has: reader.getByTitle("Upvote") }).last();
  await expect(theirs.getByText("-1", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  await purge(author, suggestion.path);
  for (const rule of rules) await purge(admin, rule);
});

/** Grant the vote verbs to everyone, the way an org opens its suggestion box. Returns the rules to remove. */
async function openTheBox(admin: import("@playwright/test").Page): Promise<string[]> {
  const made: string[] = [];
  // Reading the box is the first half of opening it: a vote grant on a board nobody may see is inert.
  const read = await admin.request.post("/v1/access-rules", {
    headers: SPA_HEADERS,
    data: { subject_kind: "role", subject: "everyone", collection: "suggestions", scope: "all", level: "read", effect: "allow" },
  });
  expect(read.status(), `read rule: ${await read.text()}`).toBe(200);
  made.push(((await read.json()) as { path: string }).path);

  for (const verb of ["upvote", "downvote"]) {
    const res = await admin.request.post("/v1/access-rules", {
      headers: SPA_HEADERS,
      // The rule the Access Management UI writes: a VERB rule (no level) on every suggestion, for the
      // `everyone` pseudo-role - "anybody may vote", which is what a suggestion box is.
      data: { subject_kind: "role", subject: "everyone", collection: "suggestions", scope: "all", verb, effect: "allow" },
    });
    expect(res.status(), `${verb} rule: ${await res.text()}`).toBe(200);
    made.push(((await res.json()) as { path: string }).path);
  }
  return made;
}
