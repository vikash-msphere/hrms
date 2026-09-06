import { gotoRoute, personId, purge, test, expect } from "./fixtures";

// Naming somebody with an `@`, and their browser hearing about it.
//
// `test/` owns the token grammar (src/domain/mentions.ts) and the notify fan-out. Everything between them is
// a browser: the run being completed is read off the CARET rather than tracked as state, so the offer appears
// only inside a short run that starts a word, arrow keys and Enter move through the list instead of reaching
// the form, and picking somebody rewrites the textarea around the caret with a token nobody typed. Then the
// same string has to render as a chip that links to the person, and land in their bell.
//
// One spec, two browsers, because a mention that only the author can see is not a mention.
test("a mention is offered from the caret, posts as a chip, and reaches the person named", async ({ as }) => {
  test.setTimeout(180_000);
  const author = await as("hr");
  const named = await as("employee");
  const stamp = Date.now();
  const title = `E2E mention ${stamp}`;
  const employeeId = await personId(author, "employee");

  await gotoRoute(named, "dashboard");
  const bell = named.getByRole("banner").getByRole("button", { name: /^Notifications/ });
  await expect(bell).toBeVisible();

  await gotoRoute(author, "announcements", "Feed");
  // The composer is one form re-shaped by the kind; "Post" is the plain one, picked by name rather than by
  // pressing the split button's default half (which is whatever the org configured).
  await author.getByRole("button", { name: "Choose what to post" }).click();
  await author.getByRole("menuitem", { name: "Post" }).click();
  const composer = author.getByRole("dialog");
  // By placeholder: the title field shares its Field with three alignment buttons, so the label names the
  // group rather than the input, and "Title" as a label also matches "Align title left/center/right".
  await composer.getByPlaceholder("Say it in a line").fill(title);

  const body = composer.getByPlaceholder("What's on your mind?");
  await body.click();
  // An `@` mid-word is an address, not a mention: `user@host` must offer nothing, or every email typed into a
  // post becomes a directory search.
  await body.fill("mail me at hank@example.com");
  await expect(composer.getByRole("button", { name: /Eve Employee/ })).toHaveCount(0);

  // At the start of a word, it is an offer - and it narrows as the name is typed.
  await body.fill("");
  await body.pressSequentially("Handing this to @Ev");
  const offer = composer.getByRole("button", { name: /Eve Employee/ });
  await expect(offer).toBeVisible();
  await expect(composer.getByRole("button", { name: /Mara Manager/ })).toHaveCount(0);

  // Enter takes the highlighted row - the mention menu gets first refusal on the key, so this must not submit
  // the form or type a newline into the body.
  await body.press("Enter");
  await expect(composer.getByRole("button", { name: /Eve Employee/ })).toHaveCount(0);
  // The token, written around the caret: the name the author picked plus the wire id the chip and the
  // notification both need. Not something a person types, and the only proof the pick rewrote the field.
  await expect(body).toHaveValue(`Handing this to [@Eve Employee](employees/${employeeId}) `);
  await body.pressSequentially("- over to you.");

  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(author.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // On the card, the same string is a chip that links to the person named - the useful thing to do with a
  // name you have just read. The raw token must not be on screen anywhere.
  const card = author.locator("div.shadow-card").filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const chip = card.getByRole("link", { name: "@Eve Employee" });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("href", `#/employees/${employeeId}`);
  await expect(card.getByText("](employees/")).toHaveCount(0);

  // And in the bell of the person who was named, in their own browser, from cold. The assertion is the
  // notification itself, not the number beside the bell: several specs share this person, and one of them
  // marking everything read mid-test would move that count in the other direction.
  await named.reload();
  await expect(named.getByRole("main")).toBeVisible();
  await bell.click();
  await expect(named.getByText("You were mentioned").first()).toBeVisible({ timeout: 30_000 });

  await purge(author, await postPath(author, title));
});

/** The wire path of the post this spec made, for taking it off the board again. */
async function postPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  const post = results.find((a) => a.title === title);
  if (!post) throw new Error(`e2e: the post "${title}" is not on the board`);
  return post.path;
}
