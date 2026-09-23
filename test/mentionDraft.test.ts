/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { mentionedTokens } from "../src/domain/mentions";
// React-free on purpose, so the worker test project can reach it - same reason as web/src/lib/splitSource.ts.
import { collapseMentions, expandMentions, type PickedMention } from "../web/src/lib/mentionText";

// The editing form of a mention against the stored one. The box shows `@Ananya Reddy` while it is being
// typed; what is stored (and what the server notifies from) is the link carrying the wire id. These two
// functions are the only join between them, so what matters here is that the round trip is lossless and that
// a name nobody can be pinned to stays plain words rather than becoming somebody else's notification.

const EVE = "b9fmbzck9620ty2q4af4rdh72m";
const MARA = "c7k3zqv8w1h05n2r6t9y4b8dpe";

const token = (name: string, id: string) => `[@${name}](employees/${id})`;
/** Expand with no directory behind it: only what the author actually picked can resolve. */
const expand = (text: string, picked: PickedMention[] = []) => expandMentions(text, picked, () => null);

describe("collapseMentions", () => {
  it("shows the name and keeps the binding", () => {
    const { text, picked } = collapseMentions(`Nice work ${token("Eve Employee", EVE)} on the migration`);
    expect(text).toBe("Nice work @Eve Employee on the migration");
    expect(picked).toEqual([{ name: "Eve Employee", id: EVE }]);
  });

  it("leaves text with no mentions in it alone", () => {
    expect(collapseMentions("mail me at hank@example.com").text).toBe("mail me at hank@example.com");
    expect(collapseMentions(null).text).toBe("");
  });
});

describe("expandMentions", () => {
  it("round-trips what was loaded for editing", () => {
    const stored = `${token("Eve Employee", EVE)} and ${token("Mara Manager", MARA)} - over to you`;
    const { text, picked } = collapseMentions(stored);
    expect(expand(text, picked)).toBe(stored);
  });

  it("carries a binding onto later repeats of the same name", () => {
    const out = expand("@Eve Employee - and again, @Eve Employee", [{ name: "Eve Employee", id: EVE }]);
    expect(out).toBe(`${token("Eve Employee", EVE)} - and again, ${token("Eve Employee", EVE)}`);
  });

  it("keeps two people of the same name apart, in the order they were picked", () => {
    const picked = [{ name: "Eve Employee", id: EVE }, { name: "Eve Employee", id: MARA }];
    expect(expand("@Eve Employee then @Eve Employee", picked))
      .toBe(`${token("Eve Employee", EVE)} then ${token("Eve Employee", MARA)}`);
  });

  it("takes the longest name that fits, not a shorter one bound beside it", () => {
    const picked = [{ name: "Eve", id: MARA }, { name: "Eve Employee", id: EVE }];
    expect(expand("@Eve Employee", picked)).toBe(token("Eve Employee", EVE));
  });

  it("does not eat the front of a longer word", () => {
    expect(expand("@Eve Employeeship", [{ name: "Eve Employee", id: EVE }])).toBe("@Eve Employeeship");
  });

  it("leaves an address alone", () => {
    expect(expand("mail me at hank@Eve Employee", [{ name: "Eve Employee", id: EVE }]))
      .toBe("mail me at hank@Eve Employee");
  });

  it("leaves a name nobody is bound to as plain words", () => {
    expect(expand("thanks @Someone Else")).toBe("thanks @Someone Else");
  });

  it("falls back to the directory for a name typed rather than picked", () => {
    const out = expandMentions("thanks @Eve Employee", [], (n) => (n === "Eve Employee" ? EVE : null));
    expect(out).toBe(`thanks ${token("Eve Employee", EVE)}`);
  });

  it("produces what the server notifies from", () => {
    const out = expand("@Eve Employee @Mara Manager", [
      { name: "Eve Employee", id: EVE },
      { name: "Mara Manager", id: MARA },
    ]);
    expect(mentionedTokens(out)).toEqual([EVE, MARA]);
  });
});
