import { describe, it, expect } from "vitest";
import { sessionBinding } from "../src/deps";

// The live replica path can't be exercised here: miniflare (the vitest runtime) has no `withSession`.
// So we test the SELECTION: pick the session when the runtime offers one, fall back to the plain binding
// when it doesn't (no crash where Sessions are unsupported).
describe("sessionBinding", () => {
  it("opens a first-unconstrained session when withSession is available", () => {
    const session = { prepare: () => {}, batch: () => {} };
    const calls: Array<string | undefined> = [];
    const d1 = {
      withSession: (c?: string) => {
        calls.push(c);
        return session;
      },
    } as unknown as D1Database;

    expect(sessionBinding(d1)).toBe(session as unknown as D1Database);
    expect(calls).toEqual(["first-unconstrained"]);
  });

  it("falls back to the plain binding when withSession is absent (miniflare)", () => {
    const d1 = { prepare: () => {}, batch: () => {} } as unknown as D1Database;
    expect(sessionBinding(d1)).toBe(d1);
  });
});
