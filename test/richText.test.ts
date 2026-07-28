import { describe, it, expect } from "vitest";
import { richExcerpt, richToPlain } from "../src/domain/richText";
// Dependency-free on purpose, so the worker test project can reach it - see web/src/lib/splitSource.ts.
import { splitSource } from "../web/src/lib/splitSource";

// The stripped mirror is what the FTS index, notification excerpts and list teasers bind to, so what matters
// here is that it returns the WORDS and nothing else - markers, and above all the attribute tokens, must not
// leak into search (a post that centres a line should not match a search for "center").

describe("richToPlain", () => {
  it("drops the block attribute line entirely", () => {
    expect(richToPlain("{center xl serif}\nHappy Diwali")).toBe("Happy Diwali");
    expect(richToPlain("{muted}\nSmall print")).toBe("Small print");
  });
  it("keeps the words of every inline marker", () => {
    expect(richToPlain("**Bold** and *soft* and ~~gone~~ and `code`")).toBe("Bold and soft and gone and code");
  });
  it("keeps link text, not the URL", () => {
    expect(richToPlain("See [the policy](https://example.com/policy) today")).toBe("See the policy today");
  });
  it("unmarks list, quote and heading lines", () => {
    expect(richToPlain("## Agenda\n- roadmap\n- hiring\n1. first\n> quoted")).toBe("Agenda\nroadmap\nhiring\nfirst\nquoted");
  });
  it("drops rules and blank lines", () => {
    expect(richToPlain("One\n\n---\n\nTwo")).toBe("One\nTwo");
  });
  it("leaves plain prose exactly as it is", () => {
    expect(richToPlain("Just a normal sentence.")).toBe("Just a normal sentence.");
    expect(richToPlain(null)).toBe("");
    expect(richToPlain("")).toBe("");
  });
});

describe("richExcerpt", () => {
  it("collapses to one line and ellipses past the limit", () => {
    expect(richExcerpt("## Title\n\n- one\n- two", 40)).toBe("Title one two");
    expect(richExcerpt("abcdefghij", 8)).toBe("abcde...");
  });
  it("leaves a short body alone", () => {
    expect(richExcerpt("**Thanks!**", 40)).toBe("Thanks!");
  });
});

// Splitting a body in two is what lets a picture stand in the middle of it with words down both sides. What
// matters is WHERE the cut lands: it must never slice a construct in half.
describe("splitSource", () => {
  it("cuts at the blank line nearest the middle", () => {
    expect(splitSource("First para.\n\nSecond para.")).toEqual(["First para.", "Second para."]);
  });
  it("prefers a blank line even when it is not exactly central", () => {
    const [a, b] = splitSource("One.\n\nTwo is a good deal longer than the first one is.");
    expect(a).toBe("One.");
    expect(b).toBe("Two is a good deal longer than the first one is.");
  });
  it("falls back to a line boundary, keeping list markers intact", () => {
    const [a, b] = splitSource("- one\n- two\n- three\n- four");
    expect(a.split("\n").every((l) => l.startsWith("- "))).toBe(true);
    expect(b.split("\n").every((l) => l.startsWith("- "))).toBe(true);
    expect(`${a}\n${b}`).toBe("- one\n- two\n- three\n- four");
  });
  it("never orphans a block from its attribute line", () => {
    // The cut may not land between `{center}` and the paragraph it governs.
    const [a, b] = splitSource("Lead in here.\n{center}\nStyled line.");
    expect(a.endsWith("{center}")).toBe(false);
    expect(b.startsWith("{center}") || !b.includes("Styled line.")).toBe(true);
  });
  it("splits a single paragraph between two words", () => {
    const [a, b] = splitSource("one two three four five six");
    expect(a.endsWith(" ")).toBe(false);
    expect(b.startsWith(" ")).toBe(false);
    expect(`${a} ${b}`).toBe("one two three four five six");
  });
  it("leaves a single heading or list item whole rather than beheading it", () => {
    expect(splitSource("## A heading of some length")).toEqual(["## A heading of some length", ""]);
    expect(splitSource("- a list item of some length")).toEqual(["- a list item of some length", ""]);
  });
  it("copes with nothing at all", () => {
    expect(splitSource("")).toEqual(["", ""]);
  });

  // The one invariant that matters more than where the cut lands: the halves put back together are the whole body.
  // A styled one-paragraph post - `{geometric}` over a line of prose - used to come back as just the attribute
  // line, so choosing a typeface made the words vanish from the card.
  it("never loses a word, whatever the body looks like", () => {
    const words = (s: string) => s.replace(/\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean).join(" ");
    for (const src of [
      "{geometric}\nHello world",
      "{center}\nOne line only here",
      "{center lg}\nA longer centred sentence that should be cut in two halves",
      "Plain single line here",
      "## Heading only",
      "- a list item of some length",
      "First para.\n\nSecond para.",
      "- one\n- two\n- three\n- four",
      "> quoted at length so the middle lands inside it",
    ]) {
      const [a, b] = splitSource(src);
      expect(words(`${a} ${b}`), src).toBe(words(src));
    }
  });

  it("carries the governing attribute line onto the second half", () => {
    // Both columns are one paragraph, so both have to be set the same way - the tail cannot lose its styling.
    const [a, b] = splitSource("{center lg}\nA longer centred sentence that should be cut in two halves");
    expect(a.startsWith("{center lg}")).toBe(true);
    expect(b.startsWith("{center lg}")).toBe(true);
  });
});
