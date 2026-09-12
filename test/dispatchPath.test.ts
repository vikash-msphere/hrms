/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { parseDispatchPath } from "../src/services/internalDispatch";
import bootstrapSql from "../bootstrap/bootstrap.sql?raw";

// WHERE AN AUTOMATION'S `apiCall` IS ALLOWED TO LAND.
//
// The dispatcher runs its request as the SYSTEM principal - the super grant - so the path it is handed is the
// whole of what decides which record is acted on. And that path is part user data: it is templated at run time
// from the event payload (services/automationEngine.ts), exactly like an email body, which is why
// `templateHtml` escapes what it substitutes. The path had no equivalent.
//
// The guard it used to have was `path.startsWith("/v1/")`, which is not a check on where the request goes:
// `new URL()` normalises first, and routes/batch.ts already learned this ("a raw `startsWith` would take
// `/v1/../healthz` for a /v1 request") for its own re-dispatcher. This is that same rule, for the sibling.

const ok = (p: string) => parseDispatchPath(p).url?.pathname;
const err = (p: string) => parseDispatchPath(p).error;

describe("dispatchable paths", () => {
  // Read from the file the rules actually ship in, so tightening the pattern cannot quietly break a shipped
  // automation: every seeded `apiCall` has to still be dispatchable with its placeholders filled in.
  it("admits every apiCall path the bootstrap rules ship", () => {
    const paths = [...bootstrapSql.matchAll(/"kind":"apiCall","method":"[A-Z]+","path":"([^"]+)"/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(10);
    // Placeholders resolve to what the engine substitutes: a bare id, or a `<collection>/<id>` subject ref.
    const resolved = [...new Set(paths.map((p) =>
      p.replace(/\{\{\s*subject\s*\}\}/g, "tickets/0abc1def2ghj3")
        .replace(/\{\{\s*results\.[^}]+\}\}/g, "tickets/0abc1def2ghj3")
        .replace(/\{\{[^}]+\}\}/g, "0abc1def2ghj3"),
    ))];
    const refused = resolved.filter((p) => !parseDispatchPath(p).url);
    expect(refused, `these shipped automation paths would stop dispatching: ${refused.join(", ")}`).toEqual([]);
  });

  it("admits the ordinary shapes", () => {
    expect(ok("/v1/transitions")).toBe("/v1/transitions");
    expect(ok("/v1/bonuses:award")).toBe("/v1/bonuses:award");
    expect(ok("/v1/applications/0abc1def2ghj3:hire")).toBe("/v1/applications/0abc1def2ghj3:hire");
    expect(ok("/v1/employees/me")).toBe("/v1/employees/me");
    // A filter is a legitimate query - two shipped rules use one.
    expect(ok("/v1/asset-requests?state=APPROVED")).toBe("/v1/asset-requests");
  });

  // The one this exists for: `startsWith("/v1/")` said yes to all of these.
  it("refuses a path that normalises out of /v1", () => {
    expect(err("/v1/../healthz")).toBeTruthy();
    expect(err("/v1/x/../../diag")).toBeTruthy();
    expect(err("/v1/../auth/login")).toBeTruthy();
    expect(err("/v1/tickets/..%2F..")).toBeTruthy();
  });

  it("refuses another origin, however it is spelled", () => {
    expect(err("https://evil.example/v1/employees")).toBeTruthy();
    expect(err("//evil.example/v1/employees")).toBeTruthy();
  });

  // A templated id carrying `?force=true` would turn a soft delete into the irreversible hard purge, and this
  // principal is never refused one. Nothing legitimate dispatches it.
  it("refuses the one parameter that lifts the required level", () => {
    expect(err("/v1/tickets/0abc1def2ghj3?force=true")).toBeTruthy();
    expect(err("/v1/departments/0abc1def2ghj3?force=false")).toBeTruthy(); // the parameter at all, not its value
  });

  // A substituted value that smuggles extra structure lands somewhere the author did not write.
  it("refuses a path with more structure than <collection>[/<id>][:verb]", () => {
    expect(err("/v1/employees/0abc1def2ghj3/bank-account")).toBeTruthy();
    expect(err("/v1/a/b/c")).toBeTruthy();
    expect(err("/v1/")).toBeTruthy();
    expect(err("/healthz")).toBeTruthy();
  });
});
