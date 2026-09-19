/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { MODERATABLE } from "../src/domain/moderation";

// Does the moderation scan still cover every public wall?
//
// WHAT WENT WRONG. `MODERATABLE` was hand-listed with `announcements` and `suggestions` and nothing held it
// against the schema, so the feature shipped scanning the two things people COMPOSE and ignoring the thing
// they fire off: `announcement_replies` is free text from any employee, on a public board card, served
// inline with every card. The careful post was checked and the sniped reply was not, which is backwards for
// the abuse this exists to catch. Poll option labels were missed the same way.
//
// WHY A TEST AND NOT A COMMENT. The sibling list `NEVER_TO_MODEL` cannot drift by construction - it is
// DERIVED from the `AUDIT` policy, and `test/aiPolicy.test.ts` holds every name in it against the collection
// registry. `MODERATABLE` has no derivation available to it: "is this text posted publicly" is not a fact
// any existing registry records. So the check is this list, maintained by hand, of every table column in the
// app that carries author-written text a colleague can read without being addressed - and a new one has to
// be classified here before the suite goes green.
//
// ADDING A SURFACE. Put it in SCANNED with the host it is flagged under, or in NOT_PUBLIC with the reason it
// needs no scan. Both are one line. What is not allowed is leaving it out: an unlisted public text column is
// exactly the hole this file was written after finding.

/** Public author-written text the scan reaches, and the flag host it lands under. */
const SCANNED: Record<string, string> = {
  "announcements.title": "announcements",
  "announcements.body": "announcements",
  // Option labels ride the announcement's own scan rather than carrying a flag of their own: they are
  // written by the post's author at poll creation, so the post is the thing a moderator decides about.
  "announcement_poll_options.label": "announcements",
  "suggestions.title": "suggestions",
  "suggestions.body": "suggestions",
  // A reply is somebody ELSE's text under the author's post, so it is flagged and hidden on its own - hiding
  // the whole thread because one reply was abusive would punish the author for what a commenter wrote.
  "announcement_replies.body": "announcement-replies",
};

/** Author-written text columns that are NOT a public wall, with why the scan skips them. */
const NOT_PUBLIC: Record<string, string> = {
  "tickets.subject": "addressed to a servicing desk, not posted to anyone",
  "tickets.description": "addressed to a servicing desk",
  "ticket_comments.body": "a thread on one ticket, read by its requester and the desk",
  "suggestions.response": "HR's reply, written by the people who would moderate it",
  "review_feedback.body": "written to a manager about one person; a moderation queue over it is a different product",
  "check_ins.body": "between one person and their manager",
  "kudos_note": "not a table - kudos are announcements with kind='kudos', already covered above",
};

describe("the moderation scan covers every public wall", () => {
  it("every scanned surface names a host the flag machinery understands", () => {
    // A host that is not in `MODERATABLE` cannot be flagged, decided or rendered: `splitHost` refuses it,
    // the queue cannot resolve it, and the scan would write rows nothing reads.
    const unknown = [...new Set(Object.values(SCANNED))].filter((host) => !MODERATABLE[host]);
    expect(unknown, `scanned text flagged under a host that is not in MODERATABLE: ${unknown.join(", ")}`).toEqual([]);
  });

  it("every host in MODERATABLE actually has text pointed at it", () => {
    // The other direction: a host nothing scans is a decision surface for content that never arrives.
    const hosts = new Set(Object.values(SCANNED));
    const idle = Object.keys(MODERATABLE).filter((h) => !hosts.has(h));
    expect(idle, `MODERATABLE names a host no scanned column flags: ${idle.join(", ")}`).toEqual([]);
  });

  it("classifies every author-written text column exactly once", () => {
    const both = Object.keys(SCANNED).filter((k) => k in NOT_PUBLIC);
    expect(both, `listed as both scanned and not-public: ${both.join(", ")}`).toEqual([]);
  });
});
