import { SPA_HEADERS, allowConsoleErrors, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// Two small, derived facts on a candidate's own page - never opened by any other spec (nothing here
// navigates to `#/candidates/<id>` at all), so neither has ever rendered.
test.describe("candidate profile", () => {
  // Who sent them in: the "Referred by" badge is the one place a referral surfaces on the candidate
  // themselves, distinct from the referral record's own page.
  test("shows who referred a candidate", async ({ as }) => {
    test.setTimeout(90_000);
    const page = await as("super");
    // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this
    // suite (complianceRuleDelete.spec.ts et al.). The badge this test reads is asserted below; a console
    // line from a request retried behind that is not its failure.
    allowConsoleErrors(page, /status of 503|status of 500/i);
    const referrer = await personPath(page, "hr");
    const candidateName = `E2E referred candidate ${Date.now()}`;

    const madeReferral = await page.request.post("/v1/referrals", {
      headers: SPA_HEADERS,
      data: { referrer, candidate_name: candidateName },
    });
    expect(madeReferral.status(), await madeReferral.text()).toBe(200);
    const referral = (await madeReferral.json()) as { path: string };

    const madeCandidate = await page.request.post("/v1/candidates", {
      headers: SPA_HEADERS,
      data: { name: candidateName, referral: referral.path },
    });
    expect(madeCandidate.status(), await madeCandidate.text()).toBe(200);
    const candidate = (await madeCandidate.json()) as { path: string };

    try {
      await gotoRoute(page, `candidates/${candidate.path.split("/").pop()}`);
      await expect(page.getByRole("heading", { name: candidateName })).toBeVisible({ timeout: 30_000 });
      // A second hop after the candidate itself: the badge names the referral, which the page reads by id once
      // it knows there is one, so it lands after the heading rather than with it.
      await expect(page.getByText(/^Referred by /)).toBeVisible({ timeout: 30_000 });
    } finally {
      await purge(page, candidate.path);
      await purge(page, referral.path);
    }
  });

  // An extended offer's own countdown: past its expiry it reads "Expired", not "Expires" - the one date on
  // this page whose label depends on which side of today it falls.
  test("an extended offer past its expiry reads Expired, not Expires", async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as("super");
    const stamp = Date.now();
    const candidateName = `E2E offer candidate ${stamp}`;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

    const madeReq = await page.request.post("/v1/job-requisitions", { headers: SPA_HEADERS, data: { title: `E2E req ${stamp}` } });
    expect(madeReq.status(), await madeReq.text()).toBe(200);
    const requisition = (await madeReq.json()) as { path: string };

    const madeCandidate = await page.request.post("/v1/candidates", { headers: SPA_HEADERS, data: { name: candidateName } });
    expect(madeCandidate.status(), await madeCandidate.text()).toBe(200);
    const candidate = (await madeCandidate.json()) as { path: string };

    const madeApp = await page.request.post("/v1/applications", {
      headers: SPA_HEADERS,
      data: { candidate: candidate.path, requisition: requisition.path },
    });
    expect(madeApp.status(), await madeApp.text()).toBe(200);
    const application = (await madeApp.json()) as { path: string };

    const madeOffer = await page.request.post("/v1/offers", {
      headers: SPA_HEADERS,
      data: { application: application.path, expiry_date: yesterday },
    });
    expect(madeOffer.status(), await madeOffer.text()).toBe(200);
    const offer = (await madeOffer.json()) as { path: string; etag: string };

    const approved = await page.request.post(`/v1/${offer.path}:approve`, { headers: { ...SPA_HEADERS, "If-Match": offer.etag } });
    expect(approved.status(), await approved.text()).toBe(200);
    const approvedEtag = ((await approved.json()) as { etag: string }).etag;
    const extended = await page.request.post(`/v1/${offer.path}:extend`, { headers: { ...SPA_HEADERS, "If-Match": approvedEtag } });
    expect(extended.status(), await extended.text()).toBe(200);

    let reissued: { path: string; etag: string } | undefined;
    try {
      await gotoRoute(page, `candidates/${candidate.path.split("/").pop()}`);
      await expect(page.getByRole("heading", { name: candidateName })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/^Expired /)).toBeVisible();
      await expect(page.getByText(/^Expires /)).toHaveCount(0);

      // The other side of the same date. An offer that is already out cannot have its terms rewritten - only
      // a draft is editable (src/services/ats.ts) - so a longer deadline is a fresh offer, which is also how
      // the Offers page does it: the Edit control is there for a draft and nothing else.
      await purge(page, offer.path);
      const madeReissue = await page.request.post("/v1/offers", {
        headers: SPA_HEADERS,
        data: { application: application.path, expiry_date: nextYear },
      });
      expect(madeReissue.status(), await madeReissue.text()).toBe(200);
      reissued = (await madeReissue.json()) as { path: string; etag: string };

      const reApproved = await page.request.post(`/v1/${reissued.path}:approve`, { headers: { ...SPA_HEADERS, "If-Match": reissued.etag } });
      expect(reApproved.status(), await reApproved.text()).toBe(200);
      const reApprovedEtag = ((await reApproved.json()) as { etag: string }).etag;
      const reExtended = await page.request.post(`/v1/${reissued.path}:extend`, { headers: { ...SPA_HEADERS, "If-Match": reApprovedEtag } });
      expect(reExtended.status(), await reExtended.text()).toBe(200);

      await page.reload();
      await expect(page.getByRole("heading", { name: candidateName })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/^Expires /)).toBeVisible();
      await expect(page.getByText(/^Expired /)).toHaveCount(0);
    } finally {
      if (reissued) await purge(page, reissued.path);
      await purge(page, offer.path);
      await purge(page, application.path);
      await purge(page, candidate.path);
      await purge(page, requisition.path);
    }
  });
});
