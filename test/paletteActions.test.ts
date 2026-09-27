import { describe, it, expect } from "vitest";
import { paletteVerbs } from "../web/src/lib/paletteActions";

// What ⌘K offers to DO to a result (web/src/lib/paletteActions.ts). Hide, never disable: a verb appears only
// when the server allows it on this record, the record is waiting on it, and it is not the caller's own.

const me = { selfEmployeeId: "employees/e1", allowSelfApproval: false };
const pendingLeave = { state: "PENDING", employee: "employees/e2", access: { can: ["approve", "reject", "cancel"] } };

describe("paletteVerbs", () => {
  it("offers approve and reject on someone else's pending request the caller may decide", () => {
    expect(paletteVerbs("leave-requests", pendingLeave, me).map((v) => v.verb)).toEqual(["approve", "reject"]);
  });

  it("offers only what the server allows on this record", () => {
    expect(paletteVerbs("leave-requests", { ...pendingLeave, access: { can: ["reject"] } }, me).map((v) => v.verb)).toEqual(["reject"]);
    expect(paletteVerbs("leave-requests", { ...pendingLeave, access: { can: [] } }, me)).toEqual([]);
  });

  it("offers nothing once the request has been decided", () => {
    expect(paletteVerbs("leave-requests", { ...pendingLeave, state: "APPROVED" }, me)).toEqual([]);
  });

  it("offers nothing on the caller's own request unless the org allows self-approval", () => {
    const own = { ...pendingLeave, employee: "employees/e1" };
    expect(paletteVerbs("leave-requests", own, me)).toEqual([]);
    expect(paletteVerbs("leave-requests", own, { ...me, allowSelfApproval: true }).map((v) => v.verb)).toEqual(["approve", "reject"]);
  });

  it("knows company expenses wait in SUBMITTED, and ignores collections with no decision", () => {
    expect(paletteVerbs("expenses", { ...pendingLeave, state: "SUBMITTED" }, me)).toHaveLength(2);
    expect(paletteVerbs("expenses", pendingLeave, me)).toEqual([]);
    expect(paletteVerbs("tickets", pendingLeave, me)).toEqual([]);
  });
});
