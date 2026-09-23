/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// DoD #1 acceptance gate: access control lives ONLY in the middleware. No service or route makes an
// access decision. We load every src/services and src/routes source (Vite `?raw`, since the worker test
// pool has no node:fs) and assert none contains an access-decision identifier, an import of the authz
// engine's deciders, or a caller role-string branch.
//
// Allowed at the service/route edge (and ONLY these): binding the middleware's verdict to columns
// (`type ListScope` + `applyScope`, which decide nothing) and emitting the client affordance payload
// (`capabilitiesOf` at /users/me, which never gates). A local workflow helper named `decide`
// (leaveRequests state transition) is NOT the authz `decide` - we forbid the IMPORT, not the word.
const s1 = import.meta.glob("../src/services/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const s2 = import.meta.glob("../src/routes/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sources = new Map<string, string>();
for (const [p, src] of [...Object.entries(s1), ...Object.entries(s2)]) sources.set(p.replace(/^\.\.\//, ""), src);

const FORBIDDEN: { re: RegExp; name: string }[] = [
  { re: /\bactorCan\b/, name: "actorCan" },
  { re: /\bactorScope\b/, name: "actorScope" },
  { re: /\bcanSee[A-Za-z]*\b/, name: "canSee*" },
  { re: /\bhasCapability\b/, name: "hasCapability" },
  { re: /\bcapabilitiesOf\b/, name: "capabilitiesOf" },
  { re: /\brequire_[a-z]/, name: "require_ backstop" },
  { re: /import\s+(?:type\s+)?\{[^}]*\b(?:decide|resolveRequest|matchTokens)\b[^}]*\}\s*from\s*["'][^"']*domain\/permissions/, name: "authz-engine import" },
  { re: /\.role\s*===?\s*["']/, name: "caller role-literal branch" },
  { re: /===?\s*["'](?:employee|manager|hr_admin|payroll_admin|super_admin)["']/, name: "role-literal comparison" },
];

// `${relpath}::${pattern}` entries that are knowingly, documentedly allowed.
const ALLOW = new Set<string>([
  "src/routes/users.ts::capabilitiesOf", // /users/me affordance payload - emits a response, never gates
  // Effective-access preview (:preview): REPORTS the engine's verdict for arbitrary subjects (the ACL
  // modal's view-as). It runs decide() to describe, never to gate - the route itself is authorized by the
  // middleware like any custom method.
  "src/services/accessPreview.ts::authz-engine import",
  // include_capabilities: emits the subject's capability payload (same as /users/me), for view-as - never gates.
  "src/services/accessPreview.ts::capabilitiesOf",
  // RECIPIENT SELECTION, not an access decision on the caller: "who handles this" - the access admins for a
  // permission request, the tax verifiers for a prior-employer declaration, the reviewers for a suggestion.
  // It asks each ROLE's grant, which is the whole point: the alternative, and what two of the three features
  // were doing, is a hardcoded `["hr_admin", "payroll_admin", "super_admin"]` that silently misses a custom
  // role and silently keeps a revoked one. The gate on the action itself is the middleware, untouched.
  //
  // It lives in ONE module now (services/capabilityHolders.ts) rather than being re-derived per feature, so
  // the exception is one file rather than one per caller - and the `decide` import is here because a
  // self-scoped grant is not authority over anyone else: `employees.me.tax.**` is held by every employee, so
  // the coarse capability test would have addressed the tax queue's mail to the entire company.
  "src/services/capabilityHolders.ts::hasCapability",
  "src/services/capabilityHolders.ts::capabilitiesOf",
  "src/services/capabilityHolders.ts::authz-engine import",
  // profile_completeness enrichment on GET /employees/{id}: owner-private flags also shared with HR as a
  // record-quality signal. Shapes the RESPONSE payload (field visibility), never gates the request - the
  // route is authorized by the middleware like any other.
  "src/routes/employees.ts::actorCan",
]);

describe("single-source access control (DoD #1)", () => {
  it("no service or route makes an access decision", () => {
    const violations: string[] = [];
    for (const [rel, src] of sources) {
      for (const { re, name } of FORBIDDEN) {
        if (re.test(src) && !ALLOW.has(`${rel}::${name}`)) violations.push(`${rel}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no dead allow-list entries (each exception still applies)", () => {
    for (const entry of ALLOW) {
      const [rel, name] = entry.split("::");
      const src = sources.get(rel!);
      const re = FORBIDDEN.find((f) => f.name === name)!.re;
      expect(src && re.test(src), `stale allow-list entry: ${entry}`).toBe(true);
    }
  });
});
