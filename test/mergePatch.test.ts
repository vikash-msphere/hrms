import { describe, it, expect } from "vitest";
import { changedFields } from "../web/src/lib/mergePatch";

// The three personal-info editors (Personal, Contact, Emergency) share one encrypted blob and each sends a merge
// patch of it. The body has to be what the reader changed and nothing else, or the retry after a 409 - form
// kept, record reloaded under it - writes the form's stale copy of everybody else's fields back over them.
describe("changedFields", () => {
  const shown: Record<string, string> = { path: "employees/x/personal-info", etag: 'W/"1"', personal_phone: "1", emergency_name: "" };

  it("sends only the keys the reader edited", () => {
    expect(changedFields({ ...shown, personal_phone: "2" }, shown)).toEqual({ personal_phone: "2" });
  });

  it("never sends the record's identity", () => {
    expect(changedFields({ ...shown, etag: 'W/"2"', path: "elsewhere" }, shown)).toEqual({});
  });

  it("sends a field the reader cleared, and one they added", () => {
    expect(changedFields({ ...shown, personal_phone: "", alternate_phone: "3" }, shown)).toEqual({ personal_phone: "", alternate_phone: "3" });
  });

  it("leaves out a field somebody else changed after the form opened", () => {
    // The reload after a 409 changed the RECORD, not the baseline: the form still holds what it was shown, so
    // an emergency contact saved meanwhile is not in the body the second press sends.
    const form = { ...shown, personal_phone: "2" };
    expect(changedFields(form, shown)).not.toHaveProperty("emergency_name");
  });
});
