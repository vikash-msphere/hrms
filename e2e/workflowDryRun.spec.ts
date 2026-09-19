import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Trying a rule out before letting it loose.
//
// An automation rule is a thing that acts on people's behalf - it notifies, it writes, it emails - so the one
// question anybody has before enabling it is "would this actually fire, and on what?". The editor answers it
// in place: a sample event as JSON, a run that evaluates the SAVED rule against it, and a verdict that says
// either which steps would run or that the condition did not match. Nothing is sent and nothing is written,
// which is exactly why it can be offered at all.
//
// `workflows` covers composing a rule and reading the preview sentence; `workflowFires` covers a real event
// reaching a real rule; `workflowLog` covers the runs afterwards. The dry run is the piece between them, and
// it is entirely a browser affair: the payload is typed, the verdict is rendered, and a payload that is not
// JSON has to be refused by the form rather than sent.
test("the editor dry-runs the saved rule against a sample event", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const name = `E2E dry run ${stamp}`;
  const category = `e2e-dry-${stamp}`;

  // Written over the wire: composing is `workflows`' subject, and this spec starts once a saved rule with a
  // condition exists. Disabled would be safer still, but the rule is fenced on a category no ticket in this
  // lane carries, so it can never fire.
  const created = await page.request.post("/v1/automations", {
    headers: SPA_HEADERS,
    data: {
      name,
      description: "Raised by the dry-run spec.",
      trigger_type: "ticket.created",
      condition: { field: "category", op: "eq", value: category },
      actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Dry run", body: "Never sent." }],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    // Straight into the rule's own editor: `/workflows/<id>` is the deep link the log, the search and a
    // copied URL all hand out, and it saves this spec hunting a card down a list every other workflow spec
    // is also writing to.
    await gotoRoute(page, `workflows/${path.split("/")[1]}`);

    const form = page.getByRole("dialog");
    await expect(form.getByLabel("Name")).toHaveValue(name, { timeout: 30_000 });

    // The dry run is folded away until it is wanted - the editor is long enough already.
    const toggle = form.getByRole("button", { name: "Test this rule" });
    await toggle.click();
    await expect(form.getByText(/Nothing is sent and nothing is written/)).toBeVisible({ timeout: 30_000 });

    // A payload that does not match the fence: the verdict has to be the honest one, not silence.
    const payload = form.locator("textarea").last();
    await payload.fill(JSON.stringify({ category: "something-else" }));
    await form.getByRole("button", { name: "Run test" }).click();
    await expect(form.getByText("The condition did not match, so nothing would run")).toBeVisible({ timeout: 30_000 });

    // And one that does: the verdict flips and names the steps that would have run, which is the answer the
    // person opened this for.
    await payload.fill(JSON.stringify({ category }));
    await form.getByRole("button", { name: "Run test" }).click();
    await expect(form.getByText("The condition matched")).toBeVisible({ timeout: 30_000 });
    await expect(form.getByText("Would run:")).toBeVisible();

    // A payload that is not JSON is the form's problem, not the server's: it says what is wrong with what was
    // typed rather than sending it and relaying a 400.
    await payload.fill("{not json");
    await form.getByRole("button", { name: "Run test" }).click();
    await expect(form.getByText(/isn't valid JSON/)).toBeVisible({ timeout: 30_000 });
  } finally {
    await purge(page, path);
  }
});
