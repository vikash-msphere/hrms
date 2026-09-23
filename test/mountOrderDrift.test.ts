/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// EVERY /v1 MOUNT SITS BEHIND THE GATE.
//
// Hono applies middleware in REGISTRATION order against the routes declared after it, so where a
// `app.route("/v1/...")` line sits relative to `app.use("/v1/*", authz)` is not style - it is whether that
// collection is access-controlled at all. A mount added above the middleware block answers with no
// authentication and no authorization, for every method it exposes, and nothing else in the app would notice:
// the route works, the tests for its service pass, and `openapiRoutesDrift` only asks whether the path is in
// the contract.
//
// This is the one invariant of its kind with no tripwire. The middleware chain itself is exhaustively
// reasoned about (middleware/authz.ts is "the SOLE access gate, fail-closed"), the collection lane is pinned
// (collectionLaneDrift), the scope binding is pinned (listScopeDrift), the purge cascades are pinned
// (purgeCascadeDrift) - and the ORDER that makes all of it apply was held by nothing but the fact that
// everyone happened to paste new mounts at the bottom.
//
// Read from source rather than by probing the app, because the failure is positional: a running app cannot
// tell you that a route would have been gated had it been declared eleven lines lower.
const indexTs = Object.values(
  import.meta.glob("../src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;

const lines = indexTs.split("\n");
/** 1-indexed line of the first match, or -1. */
const lineOf = (re: RegExp) => lines.findIndex((l) => re.test(l)) + 1;

// The gate itself, and the two that must precede it to make it meaningful: `auth` supplies the principal
// `authz` decides about, and `dbContext` supplies the Deps both read.
const AUTHZ = /^app\.use\("\/v1\/\*",\s*authz\)/;
const AUTH = /^app\.use\("\/v1\/\*",\s*auth\)/;
const DB_CONTEXT = /^app\.use\("\/v1\/\*",\s*dbContext\)/;
const V1_MOUNT = /^app\.route\("(\/v1[^"]*)"/;

describe("/v1 routes are mounted behind the access gate", () => {
  const authzAt = lineOf(AUTHZ);
  const authAt = lineOf(AUTH);
  const dbAt = lineOf(DB_CONTEXT);

  it("finds the middleware chain (sanity: the matchers still work)", () => {
    expect(authzAt, "app.use(\"/v1/*\", authz) not found in src/index.ts").toBeGreaterThan(0);
    expect(authAt, "app.use(\"/v1/*\", auth) not found in src/index.ts").toBeGreaterThan(0);
    expect(dbAt, "app.use(\"/v1/*\", dbContext) not found in src/index.ts").toBeGreaterThan(0);
  });

  it("resolves deps and the caller before deciding about them", () => {
    // authz reads `c.get("user")` and `c.get("deps")`; registered above either, it decides with neither.
    expect(dbAt).toBeLessThan(authAt);
    expect(authAt).toBeLessThan(authzAt);
  });

  it("declares every /v1 mount after authz", () => {
    const mounts = lines
      .map((l, i) => ({ line: i + 1, m: V1_MOUNT.exec(l) }))
      .filter((x): x is { line: number; m: RegExpExecArray } => x.m !== null)
      .map((x) => ({ line: x.line, path: x.m[1]! }));

    expect(mounts.length, "sanity: the mount matcher found nothing").toBeGreaterThan(50);

    const ungated = mounts.filter((x) => x.line < authzAt).map((x) => `${x.path} (line ${x.line})`);
    expect(
      ungated,
      `these /v1 routes are mounted BEFORE app.use("/v1/*", authz) on line ${authzAt}, so the gate never runs ` +
        "for them - they answer with no authentication and no authorization. Move the mount below the " +
        "middleware block.",
    ).toEqual([]);
  });
});
