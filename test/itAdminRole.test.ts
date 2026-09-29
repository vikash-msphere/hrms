import { describe, it, expect } from "vitest";
import { grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide, type Grant } from "../src/domain/permissions";
import { mergeGrants, rulesToGrant } from "../src/domain/compileGrants";

// Who runs IT, as the seeded roles say it. it_admin owns the asset register and the asset desk; hr_admin no longer
// touches assets but can reset a forgotten app PIN; neither reaches platform or security administration. The IT
// ticket queue is not in any role rule (a ticket's code is its requester's), so it is checked here the way it is
// granted: the per-ticket role pair services/ticketShares.ts writes, overlaid on the role.
const SELF = { employeeCode: "0b-001" };
const IT_TICKET = "04-1c-0a9-3";
const HR_TICKET = "04-1c-0a9-4";
const ASSET = "0000k";

const as = (g: Grant) => (m: string, p: string) => decide(g, resolveRequest(m, p, false), SELF).allow;
const itAdmin = as(grantFor("it_admin"));
const hrAdmin = as(grantFor("hr_admin"));

// The pair a servicing role gets on one ticket (ticketShares.ts roleServiceRows).
const servicePair = (code: string) =>
  rulesToGrant([
    { namespace: "tickets", pattern: `tickets.${code}.**`, scopeKind: "exact", scopeCode: code, matchCode: code, level: "write", effect: "allow" },
    { namespace: "tickets", pattern: `tickets.${code}.**`, scopeKind: "exact", scopeCode: code, matchCode: code, level: null, effect: "allow" },
  ]);
const itServicing = as(mergeGrants(grantFor("it_admin"), servicePair(IT_TICKET)));

const PLATFORM = ["access-rules", "roles", "policy", "api-keys", "audit"];

describe("it_admin", () => {
  it("runs the asset register, its catalogue, stocktakes and the asset desk", () => {
    expect(itAdmin("GET", "/v1/assets")).toBe(true);
    expect(itAdmin("GET", `/v1/assets/${ASSET}`)).toBe(true);
    expect(itAdmin("PATCH", `/v1/assets/${ASSET}`)).toBe(true);
    expect(itAdmin("POST", `/v1/assets/${ASSET}:verify`)).toBe(true);
    expect(itAdmin("PATCH", "/v1/asset-categories/0000m")).toBe(true);
    expect(itAdmin("POST", "/v1/stocktakes")).toBe(true);
    expect(itAdmin("POST", "/v1/asset-requests/04-1c-0a9-1:approve")).toBe(true);
    expect(itAdmin("POST", "/v1/asset-requests/04-1c-0a9-1:issue")).toBe(true);
    expect(itAdmin("PATCH", "/v1/settings/asset-tags")).toBe(true);
  });

  it("works a ticket its role services, and no other", () => {
    expect(itServicing("GET", `/v1/tickets/${IT_TICKET}`)).toBe(true);
    expect(itServicing("POST", `/v1/tickets/${IT_TICKET}:resolve`)).toBe(true);
    expect(itServicing("POST", `/v1/tickets/${IT_TICKET}:assign`)).toBe(true);
    expect(itServicing("GET", `/v1/tickets/${HR_TICKET}`)).toBe(false);
    expect(itServicing("POST", `/v1/tickets/${HR_TICKET}:resolve`)).toBe(false);
    // With no share at all, the role reaches no ticket but its holder's own.
    expect(itAdmin("GET", `/v1/tickets/${IT_TICKET}`)).toBe(false);
  });

  it("holds no platform, security or governance authority", () => {
    for (const c of PLATFORM) {
      expect(itAdmin("GET", `/v1/${c}`), c).toBe(false);
      expect(itAdmin("POST", `/v1/${c}`), c).toBe(false);
    }
    expect(itAdmin("GET", "/v1/users")).toBe(false);
    expect(itAdmin("POST", "/v1/users/0000p:resetPin")).toBe(false);
    for (const k of ["access-approval", "sign-in", "ai", "ticket-categories"]) expect(itAdmin("PATCH", `/v1/settings/${k}`), k).toBe(false);
  });
});

describe("hr_admin", () => {
  it("no longer reaches the asset register, stocktakes or the asset desk", () => {
    expect(hrAdmin("GET", `/v1/assets/${ASSET}`)).toBe(false);
    expect(hrAdmin("PATCH", `/v1/assets/${ASSET}`)).toBe(false);
    expect(hrAdmin("POST", `/v1/assets/${ASSET}:verify`)).toBe(false);
    expect(hrAdmin("POST", "/v1/stocktakes")).toBe(false);
    expect(hrAdmin("PATCH", "/v1/asset-categories/0000m")).toBe(false);
    expect(hrAdmin("POST", "/v1/asset-requests/07-2a-0b1-1:approve")).toBe(false);
    expect(hrAdmin("POST", "/v1/asset-requests/07-2a-0b1-1:issue")).toBe(false);
    expect(hrAdmin("PATCH", "/v1/settings/asset-tags")).toBe(false);
    // Still reads the categories, like every employee.
    expect(hrAdmin("GET", "/v1/asset-categories/0000m")).toBe(true);
  });

  it("resets an app PIN from the account list, and changes nothing else about an account", () => {
    expect(hrAdmin("GET", "/v1/users")).toBe(true);
    expect(hrAdmin("GET", "/v1/users/0000p")).toBe(true);
    expect(hrAdmin("POST", "/v1/users/0000p:resetPin")).toBe(true);
    expect(hrAdmin("PATCH", "/v1/users/0000p")).toBe(false);
  });

  it("keeps the help desk", () => {
    expect(hrAdmin("GET", `/v1/tickets/${IT_TICKET}`)).toBe(true);
    expect(hrAdmin("POST", `/v1/tickets/${IT_TICKET}:resolve`)).toBe(true);
  });

  it("holds no platform, security or governance authority", () => {
    for (const c of PLATFORM) {
      expect(hrAdmin("GET", `/v1/${c}`), c).toBe(false);
      expect(hrAdmin("POST", `/v1/${c}`), c).toBe(false);
    }
    for (const k of ["access-approval", "access-review", "sign-in", "ai", "attachments"]) expect(hrAdmin("PATCH", `/v1/settings/${k}`), k).toBe(false);
  });
});
