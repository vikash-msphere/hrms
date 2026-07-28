import { describe, it, expect } from "vitest";
import { getSignature, uploadSignature, clearSignature } from "../src/services/employeePhoto";

// A signature image is owner-private: only its owner may read, upload, or clear it - no employees.* grant
// (HR/super included) overrides this. assertOwner runs before any I/O, so a bare deps suffices here.
const deps = {} as any;
const other = { employeeId: "emp_other", email: "hr@example.com" } as any;
const noEmployee = { employeeId: null, email: "super@example.com" } as any;
const TARGET = "emp_owner";

describe("signature is owner-private", () => {
  it("getSignature rejects a non-owner", async () => {
    await expect(getSignature(deps, other, TARGET)).rejects.toThrow();
  });
  it("uploadSignature rejects a non-owner", async () => {
    await expect(uploadSignature(deps, other, TARGET, new ArrayBuffer(8))).rejects.toThrow();
  });
  it("clearSignature rejects a non-owner", async () => {
    await expect(clearSignature(deps, other, TARGET)).rejects.toThrow();
  });
  it("rejects an actor with no linked employee", async () => {
    await expect(getSignature(deps, noEmployee, TARGET)).rejects.toThrow();
  });
});
