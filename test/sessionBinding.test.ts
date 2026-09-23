import { describe, it, expect } from "vitest";
import { sessionBinding } from "../src/deps";

// The live replica path can't be exercised here: this runtime has no real replicas. So we test the
// SELECTION - and since a runtime upgrade, selection takes TWO facts rather than one.
//
// It used to be feature-detection alone: open a session if the runtime has `withSession`, on the premise
// that only the deployed one does. The local runtime acquired the method, a session against a local
// database reached for the real one, and every request in `wrangler dev` died at its first query with
// `internal error; reference = …`. The deployment now declares it (`D1_SESSIONS`), and the case worth
// pinning is the one that broke: a runtime that CAN open a session but must not.
describe("sessionBinding", () => {
  const withSessionD1 = () => {
    const session = { prepare: () => {}, batch: () => {} };
    const calls: Array<string | undefined> = [];
    const d1 = {
      withSession: (c?: string) => {
        calls.push(c);
        return session;
      },
    } as unknown as D1Database;
    return { d1, session, calls };
  };

  it("opens a first-unconstrained session when the deployment asks for one", () => {
    const { d1, session, calls } = withSessionD1();
    expect(sessionBinding(d1, true)).toBe(session as unknown as D1Database);
    expect(calls).toEqual(["first-unconstrained"]);
  });

  it("does NOT open one on a runtime that offers it but has not been asked", () => {
    // The local-dev case, and the whole reason this takes an argument. Opening the session here is what
    // made the local stack unusable, so the assertion is that `withSession` is never even called.
    const { d1, calls } = withSessionD1();
    expect(sessionBinding(d1, false)).toBe(d1);
    expect(calls).toEqual([]);
  });

  it("falls back to the plain binding when withSession is absent", () => {
    const d1 = { prepare: () => {}, batch: () => {} } as unknown as D1Database;
    expect(sessionBinding(d1, true)).toBe(d1);
    expect(sessionBinding(d1, false)).toBe(d1);
  });
});
