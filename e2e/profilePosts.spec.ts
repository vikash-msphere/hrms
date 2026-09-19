import { SPA_HEADERS, allowConsoleErrors, gotoRoute, personId, test, expect } from "./fixtures";

// A person's Posts tab: what they put on the board and in the suggestion box, on their own profile and on
// somebody else's.
//
// The reads behind it are server-filtered (`?author=` / `?submitter=`), which `profilePostsFilter.test.ts`
// owns at the service level. What only a browser has is the rest of the claim: that the tab shows THIS
// person's writing rather than the board's newest, that the row reaches the post when pressed - and the one
// that matters, that an anonymous suggestion is on its submitter's own tab and on nobody else's. That last is
// a promise the suggestion box makes to everyone who uses it, and it is now made in a second place.
//
// Written as super and read back as hr, because the seeded policy says so: both the board and the box are
// write-gated, and the ordinary employee fixture holds neither grant (it can vote on a suggestion, not file
// one) - every board and box spec in this suite authors as super for the same reason. hr is the colleague
// here: somebody who reads the directory and the box, and so would see an attribution if one leaked.
test("a profile's posts: what they wrote, what they joined, and an anonymous suggestion kept to them", async ({ as }) => {
  test.setTimeout(240_000);
  const author = await as("super");
  const colleague = await as("hr");
  // A dev Worker restart mid-request on a busy lane, the same hiccup this suite tolerates by name throughout.
  // What this test reads is which rows are listed, which no console line tells it.
  allowConsoleErrors(author, /status of (500|503)/i);
  allowConsoleErrors(colleague, /status of (500|503)/i);
  const stamp = Date.now() % 1000000;
  const posted = `E2E board post ${stamp}`;
  const signed = `E2E signed idea ${stamp}`;
  const hidden = `E2E anonymous idea ${stamp}`;
  const replyBody = `E2E reply ${stamp}`;

  const made: string[] = [];
  for (const [path, data] of [
    ["/v1/announcements", { title: posted, body: "Written by the profile-posts spec.", kind: "announcement" }],
    ["/v1/suggestions", { title: signed, body: signed }],
    ["/v1/suggestions", { title: hidden, body: hidden, anonymous: true }],
  ] as const) {
    const res = await author.request.post(path, { headers: SPA_HEADERS, data });
    expect(res.status(), await res.text()).toBe(200);
    made.push(((await res.json()) as { path: string }).path);
  }
  // A kudos about somebody else - the card whose whole point is WHO was recognised, which is the name the tab
  // was not printing. The recipient is a ref on the row, never part of the title.
  const recipientId = await personId(author, "employee");
  const kudos = await author.request.post("/v1/announcements:giveKudos", {
    headers: SPA_HEADERS,
    data: { recipient: `employees/${recipientId}`, message: `E2E kudos ${stamp}` },
  });
  expect(kudos.status(), await kudos.text()).toBe(200);
  made.push(((await kudos.json()) as { path: string }).path);
  // The name as the directory holds it, not as this spec guesses it - the card prints what the employees
  // collection says, so that is what the assertion has to compare against.
  const recipientRow = await author.request.get(`/v1/employees/${recipientId}`);
  expect(recipientRow.status(), await recipientRow.text()).toBe(200);
  const { first_name, last_name } = (await recipientRow.json()) as { first_name: string; last_name: string };
  const recipientName = `${first_name} ${last_name}`;

  // And a reply on somebody else's post, so the tab has a conversation they JOINED rather than started.
  const theirPost = await colleague.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title: `E2E colleague post ${stamp}`, body: "Asked by the profile-posts spec.", kind: "announcement" },
  });
  expect(theirPost.status(), await theirPost.text()).toBe(200);
  const joinedPath = ((await theirPost.json()) as { path: string }).path;
  made.push(joinedPath);
  const replied = await author.request.post(`/v1/${joinedPath}:reply`, { headers: SPA_HEADERS, data: { body: replyBody } });
  expect(replied.status(), await replied.text()).toBe(200);

  try {
    const who = await personId(author, "super");

    // Their own profile: all three. The anonymous one is badged, so they can see which of them nobody else
    // can trace back to them.
    await gotoRoute(author, "profile"); // one record page, two addresses: its `h1` is the person's name
    await author.getByRole("tab", { name: "Posts", exact: true }).click();
    const mine = author.getByRole("tabpanel");
    await expect(mine.getByText(posted)).toBeVisible({ timeout: 30_000 });
    await expect(mine.getByText(signed)).toBeVisible();
    await expect(mine.getByText(hidden)).toBeVisible();
    await expect(mine.getByText("Anonymous").first()).toBeVisible();
    // The kudos row names who it was for. Without this it read as a bare "Kudos", which is the one thing a
    // kudos card must never leave out.
    await expect(mine.getByText(`Kudos to ${recipientName}`)).toBeVisible();
    // The conversation they joined: their own reply, on somebody else's post.
    await expect(mine.getByText(replyBody)).toBeVisible();

    // A colleague on that person's record: the post and the signed suggestion, and NOT the anonymous one.
    await gotoRoute(colleague, `employees/${who}`);
    await colleague.getByRole("tab", { name: "Posts", exact: true }).click();
    const theirs = colleague.getByRole("tabpanel");
    await expect(theirs.getByText(posted)).toBeVisible({ timeout: 30_000 });
    await expect(theirs.getByText(signed)).toBeVisible();
    await expect(theirs.getByText(hidden), "an anonymous suggestion was attributed on its submitter's profile").toHaveCount(0);

    // And the row is a way IN to the post, not just a line about it.
    await theirs.getByText(posted).click();
    await expect.poll(() => colleague.url()).toContain("/announcements/");
    await expect(colleague.getByText(posted).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    for (const path of made) {
      const got = await author.request.get(`/v1/${path}`);
      if (!got.ok()) continue;
      const { etag } = (await got.json()) as { etag: string };
      await author.request.delete(`/v1/${path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
    }
  }
});
