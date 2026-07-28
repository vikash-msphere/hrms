import { describe, it, expect } from "vitest";
import { buildCodedPath, type IdResolver } from "../src/lib/authzResolve";

// Fake resolver: maps a known uuid to a code; everything else unresolved (null).
const fake: IdResolver = async (collection, id) =>
  collection === "employees" && id === "UUID-1" ? "04-1c-0a9" : id === "UUID-LR" ? "04-1c-0a9-0kf" : null;

describe("buildCodedPath", () => {
  it("resolves the top resource id to its code", async () => {
    expect(await buildCodedPath("/v1/employees/UUID-1", fake)).toBe("/v1/employees/04-1c-0a9");
  });
  it("keeps sub-resource segments literal", async () => {
    expect(await buildCodedPath("/v1/employees/UUID-1/bank-account", fake)).toBe("/v1/employees/04-1c-0a9/bank-account");
  });
  it("preserves a trailing :verb", async () => {
    expect(await buildCodedPath("/v1/leave-requests/UUID-LR:approve", fake)).toBe("/v1/leave-requests/04-1c-0a9-0kf:approve");
  });
  it("leaves `me` and `-` (parent wildcard) literal", async () => {
    expect(await buildCodedPath("/v1/employees/me", fake)).toBe("/v1/employees/me");
    expect(await buildCodedPath("/v1/employees/me/bank-account", fake)).toBe("/v1/employees/me/bank-account");
    expect(await buildCodedPath("/v1/employees/-/leave-requests", fake)).toBe("/v1/employees/-/leave-requests");
  });
  it("leaves collection-only paths and unresolved ids unchanged", async () => {
    expect(await buildCodedPath("/v1/holidays", fake)).toBe("/v1/holidays");
    expect(await buildCodedPath("/v1/employees/UNKNOWN", fake)).toBe("/v1/employees/UNKNOWN");
  });
});
