import { describe, it, expect } from "vitest";
import { readersVisibleTo } from "../src/services/announcements";

// Who gets a board post's `read_by` / `read_count`. A read receipt names a person, so the list goes to the
// post's author (their own post) or to someone who may edit it (moderation), and to nobody else. The second half
// is a question about what the caller MAY DO, answered from the access hint (`can`) rather than from a role
// name - which is why the hint has to be computed before the post is serialized.
const post = { authorEmployeeId: "emp_author" };
const orphan = { authorEmployeeId: null };

describe("who may see a post's readers", () => {
  it("the author, whatever else they may do", () => {
    expect(readersVisibleTo(post, "emp_author")).toBe(true);
    expect(readersVisibleTo(post, "emp_author", [])).toBe(true);
  });

  it("anyone who may edit the post - a share that lifts them to editor lifts this with it", () => {
    expect(readersVisibleTo(post, "emp_other", ["update", "delete"])).toBe(true);
  });

  it("nobody else: a reader, a reactor, a caller with no employee identity", () => {
    expect(readersVisibleTo(post, "emp_other", ["react", "reply", "markRead"])).toBe(false);
    expect(readersVisibleTo(post, "emp_other")).toBe(false);
    expect(readersVisibleTo(post, null, ["react"])).toBe(false);
  });

  it("an authorless post is nobody's own, so only an editor sees its readers", () => {
    expect(readersVisibleTo(orphan, null)).toBe(false);
    expect(readersVisibleTo(orphan, "emp_other")).toBe(false);
    expect(readersVisibleTo(orphan, "emp_other", ["update"])).toBe(true);
  });
});
