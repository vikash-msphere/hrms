/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { checkReviewDraft } from "../web/src/lib/reviewDraftCheck";

// A check on what the manager wrote, before it is shared.
//
// The properties worth holding: it is about the SENTENCE and never about the employee, it finds the word it
// is complaining about so a person can disagree with it, and it says nothing at all about a review that is
// specific and neutral - a checker that always has an opinion is one people learn to dismiss unread.

const SPECIFIC_GOOD = "Led the payments migration in Q3, which moved 40% of traffic with no downtime. " +
  "Took over the on-call rota in August and rewrote the runbook after the first incident. " +
  "Next cycle I would like to see more delegation on the smaller pieces.";

describe("what it says nothing about", () => {
  it("is silent on a specific, neutral review", () => {
    expect(checkReviewDraft(SPECIFIC_GOOD)).toEqual([]);
  });

  it("is silent on an empty box, which is the form's own problem", () => {
    expect(checkReviewDraft("")).toEqual([]);
    expect(checkReviewDraft("   ")).toEqual([]);
  });
});

describe("what it flags", () => {
  it("notices that nothing specific is named", () => {
    const flags = checkReviewDraft(
      "A solid cycle overall. Delivered what was asked of them and worked well with the rest of the team, " +
      "and I would be happy to have them take on more responsibility going forward as things develop.",
    );
    expect(flags.map((f) => f.code)).toContain("no_specifics");
  });

  it("notices a word that describes the person rather than the work, and quotes it", () => {
    const flags = checkReviewDraft(`${SPECIFIC_GOOD} Their attitude has been excellent throughout.`);
    const flag = flags.find((f) => f.code === "personality");
    expect(flag?.found).toBe("attitude");
    // The complaint is about the sentence, so it says what to write instead.
    expect(flag?.message).toMatch(/What did they do/);
  });

  it("does not match a listed word inside another one", () => {
    // "nice" inside "unnoticed" is the class of false positive that teaches people to ignore the panel.
    expect(checkReviewDraft(`${SPECIFIC_GOOD} None of this went unnoticed by the team.`).map((f) => f.code))
      .not.toContain("personality");
  });

  it("notices an absolute", () => {
    const flags = checkReviewDraft(`${SPECIFIC_GOOD} They always leave the documentation until last.`);
    expect(flags.find((f) => f.code === "absolutes")?.found).toBe("always");
  });

  it("notices a comparison to a colleague", () => {
    const flags = checkReviewDraft(`${SPECIFIC_GOOD} Their output was better than most of the team this year.`);
    expect(flags.find((f) => f.code === "comparison")?.found).toBe("better than");
  });

  it("calls a two-line review thin, and does not also complain that it is vague", () => {
    const flags = checkReviewDraft("Good year. Keep it up.");
    expect(flags.map((f) => f.code)).toEqual(["very_short"]);
  });

  it("leads with the finding that changes a review most", () => {
    const flags = checkReviewDraft(
      "They have a great attitude and always deliver, and everyone on the team says the same thing about " +
      "them whenever their name comes up in any conversation about the work at hand.",
    );
    expect(flags[0]!.code).toBe("no_specifics");
  });
});
