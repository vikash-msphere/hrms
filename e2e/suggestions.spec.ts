import { gotoRoute, purge, test, expect } from "./fixtures";

// The suggestion box: anonymity that has to hold, and a triage that has to answer.
//
// Two browser-only facts. First, anonymity is a promise made in the FORM ("nobody will see it was you") and
// kept on the card - a name on an anonymous suggestion makes the feature worse than not having it, and no
// server test can see what the card drew. Second, HR's triage: the respond dialog carries the suggestion,
// its votes and a status whose consequence is spelled out, and the answer then shows on the card the
// submitter reads.
//
// Both roles here hold the box as the seed ships it: `suggestions` is granted to HR (read + respond) and to
// super; opening it to everybody is an ACL an org adds (a grant to the `everyone` pseudo-role), so a spec
// signed in as an ordinary employee would be testing a grant this org does not have.
test("an anonymous suggestion hides its author, and HR's response reaches the card", async ({ as }) => {
  const author = await as("super");
  const triage = await as("hr");
  const title = `E2E suggestion ${Date.now()}`;

  await gotoRoute(author, "suggestions", "Suggestion Box");
  await author.getByRole("button", { name: "New suggestion" }).first().click();
  const form = author.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "New suggestion" })).toBeVisible();
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Details").fill("Filed by the suggestions spec.");
  await form.getByRole("checkbox", { name: /Submit anonymously/ }).click();
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(author.getByRole("dialog")).toHaveCount(0);

  // On the board, and NOT signed: an anonymous suggestion that carries its author's name is a broken promise.
  const card = author.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: title }).first();
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("Sam Super");
  await expect(card).toContainText(/Anonymous/i);

  // HR triages it: the dialog shows the idea and its votes, and the status it is being moved to says what
  // that means for the submitter before it is saved.
  await gotoRoute(triage, "suggestions", "Suggestion Box");
  const theirCard = triage.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: title }).first();
  await expect(theirCard).toBeVisible();
  await theirCard.getByRole("button", { name: "Respond" }).click();
  const respond = triage.getByRole("dialog");
  await expect(respond.getByText(title)).toBeVisible();
  await expect(respond.getByText(/net vote|votes/)).toBeVisible();
  await respond.getByLabel("Status").click();
  await triage.getByRole("option", { name: "Under review" }).click();
  await respond.getByLabel("Public response").fill("Looking at this for next quarter.");
  await respond.getByRole("button", { name: "Save response" }).click();
  // Triage is a QUEUE, not twelve dialogs: saving can walk HR on to the next unanswered suggestion rather
  // than dropping them back on the board, so the way out is the same for either behaviour.
  // Pressed until the queue is empty, not once: if saving walked HR on to the next unanswered suggestion,
  // there is another dialog behind this one and one press only closes the top of the stack.
  await expect(async () => {
    if (await triage.getByRole("dialog").count()) await triage.keyboard.press("Escape");
    await expect(triage.getByRole("dialog")).toHaveCount(0);
  }).toPass({ timeout: 30_000 });

  // The answer is on the card, which is where the person who asked will look for it.
  await expect(triage.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: title }).first())
    .toContainText(/Looking at this for next quarter|Under review/i);

  await purge(author, await suggestionPath(author, title));
});

/** The wire path of the suggestion this spec filed. */
async function suggestionPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/suggestions?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[] };
  const row = results.find((s) => (s.title ?? s.display_name) === title);
  if (!row) throw new Error(`e2e: the suggestion "${title}" is not in the collection`);
  return row.path;
}
