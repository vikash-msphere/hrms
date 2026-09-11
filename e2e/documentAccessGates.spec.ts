import { hasCapability } from "../web/src/lib/perm";
import { ROLES, allowConsoleErrors, capabilitiesOf, gotoRoute, personId, test, expect, type Role } from "./fixtures";

// The Documents shelf is one page holding two collections with very different rules.
//
// `org-documents` is the company's paperwork (policies, handbooks) and `personal-documents` is each person's
// own file - and the page shows them in ONE list, deciding per affordance which of the two capabilities is
// required: uploading is `org-documents.write`, generating a letter into somebody's file is
// `personal-documents.write`, and an employee holds neither (they hold READ on their own personal documents
// and nothing on the org's, by default - src/domain/grants.ts).
//
// That makes this page the easiest one in the app to leak from: a single list, a single header, and three
// different gates behind it. `documentUpload`, `documentAck` and the rest all drive it as an admin, so
// nothing checks what anybody else is offered - and the drag-and-drop lane (a whole second way to file a
// document) is gated by the same flag, which nothing checks either.
test.describe("document affordance gates", () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    test(`${role} is offered exactly the document actions they hold`, async ({ as }) => {
      test.setTimeout(180_000);
      const page = await as(role);
      // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
      // (complianceRuleDelete.spec.ts et al.) - a genuinely wrong gate still fails the assertions below, so
      // this only excuses the transient network noise, never a real mismatch.
      allowConsoleErrors(page, /status of 503/i);
      await gotoRoute(page, "documents");
      // A role that cannot read either collection gets the wall, and that is the whole answer for them.
      if (await page.getByText("You don't have access to this").count()) return;
      await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible({ timeout: 30_000 });

      const caps = await capabilitiesOf(page);
      const canUpload = hasCapability(caps, "org-documents.write");
      const canGenerate = hasCapability(caps, "personal-documents.write");

      await expect(
        page.getByRole("button", { name: "Upload document", exact: true }),
        `Upload document disagreed with org-documents.write for ${role}`,
      ).toHaveCount(canUpload ? 1 : 0);
      await expect(
        page.getByRole("button", { name: "Generate letter", exact: true }),
        `Generate letter disagreed with personal-documents.write for ${role}`,
      ).toHaveCount(canGenerate ? 1 : 0);
    });
  }

  test("an employee sees their own file and cannot reach anybody else's", async ({ as }) => {
    test.setTimeout(180_000);
    const admin = await as("super");
    const page = await as("employee");

    // Their own documents tab exists on their own record - the read they DO hold.
    const own = await personId(page, "employee");
    await gotoRoute(page, `employees/${own}`);
    await expect(page.getByRole("tab", { name: "Documents", exact: true })).toBeVisible({ timeout: 30_000 });

    // Somebody else's file is not theirs to list, whichever way it is asked for: the sub-resource read is
    // scoped to the owner, so a colleague's id answers with nothing of theirs.
    const other = await personId(admin, "hr");
    const listed = await page.request.get(`/v1/personal-documents?employee=employees/${other}&page_size=50`);
    // Either refused outright or scoped to nothing - both are correct, a colleague's paperwork is not.
    if (listed.status() === 200) {
      const body = (await listed.json()) as { results?: { employee?: string }[] };
      const leaked = (body.results ?? []).filter((d) => d.employee?.endsWith(other));
      expect(leaked, "an employee could list a colleague's personal documents").toEqual([]);
    } else {
      expect(listed.status()).toBe(403);
    }
  });
});
