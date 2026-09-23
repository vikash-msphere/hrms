import { describe, it, expect } from "vitest";
import { resolveRequest, decide } from "../src/domain/permissions";
import { rulesToGrant, deriveNarrowing, type CompiledRule } from "../src/domain/compileGrants";
import { actorScope } from "../src/domain/access";
import type { AppUser } from "../src/env";

// The bootstrap seeds two `everyone` rules so a person can see and confirm the assets they HOLD
// (bootstrap/collections/authz.ts). Both look broader than they are, and both would be a whole-inventory BOLA
// if they were what they look like, so this pins the two properties they rest on:
//
//   1. `assets` (1 token) matches the bare collection key - the LIST call - and NEVER a 2-token item key. It
//      grants the right to call the endpoint and says nothing about which rows come back; actorScope probes
//      an item read to settle the breadth, finds nothing, and resolves `own` -> WHERE assigned_to = me.
//   2. the verb rule is `**`-scoped rather than `me`-scoped ON PURPOSE: an asset's code is flat (it is not
//      minted under its holder's employee code, and ownership moves between people), so a `me` pattern can
//      never match an asset and the rule would be silently inert. Holder-only lives in acknowledgeAsset,
//      which refuses anyone but `assigned_to` (covered in test/assetCustody.test.ts).
const SELF = { employeeCode: "04-002-001" };
const rule = (pattern: string, level: "read" | "write" | null): CompiledRule => {
  const n = deriveNarrowing(pattern);
  return { namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeKind === "exact" ? n.scopeCode : null, level, effect: "allow" };
};

// Exactly what bootstrap/collections/authz.ts inserts for `everyone`.
const HOLDER = rulesToGrant([rule("assets", "read"), rule("assets.**.acknowledge", null)]);
const allows = (method: string, path: string) => decide(HOLDER, resolveRequest(method, path), SELF).allow;
const actor = { grant: HOLDER, employeeCode: SELF.employeeCode } as unknown as Pick<AppUser, "grant" | "employeeCode">;

// A real asset code: flat, three chars, nothing to do with anyone's employee code.
const ASSET = "0a1";

describe("the day-one asset grant reaches the list endpoint, never the inventory", () => {
  it("allows the list call", () => {
    expect(allows("GET", "/v1/assets")).toBe(true);
  });

  it("does NOT allow reading any individual asset", () => {
    expect(allows("GET", `/v1/assets/${ASSET}`)).toBe(false);
    expect(allows("GET", "/v1/assets/zzzzz")).toBe(false); // the unscoped probe actorScope uses
    expect(allows("GET", "/v1/assets/04-002-001-9")).toBe(false); // even a code that looks like the caller's
  });

  it("resolves the list breadth to own rows, so the WHERE binds assigned_to = me", () => {
    expect(actorScope(actor, "assets")).toBe("own");
  });

  it("grants no writes and no verb other than acknowledge", () => {
    expect(allows("PATCH", `/v1/assets/${ASSET}`)).toBe(false);
    expect(allows("POST", "/v1/assets")).toBe(false);
    expect(allows("DELETE", `/v1/assets/${ASSET}`)).toBe(false);
    expect(allows("POST", `/v1/assets/${ASSET}:verify`)).toBe(false);
    expect(allows("POST", `/v1/assets/${ASSET}:printTag`)).toBe(false); // so the tag secret stays hidden
    expect(allows("POST", `/v1/assets/${ASSET}:acknowledge`)).toBe(true);
  });

  it("a `me`-scoped rule would have been inert here - which is why the verb is `**`-scoped", () => {
    const meScoped = rulesToGrant([rule("assets.me.**", "read"), rule("assets.me.acknowledge", null)]);
    expect(decide(meScoped, resolveRequest("GET", `/v1/assets/${ASSET}`), SELF).allow).toBe(false);
    expect(decide(meScoped, resolveRequest("POST", `/v1/assets/${ASSET}:acknowledge`), SELF).allow).toBe(false);
  });
});
