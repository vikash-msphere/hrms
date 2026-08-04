import { describe, it, expect } from "vitest";
import { richExcerpt, richToPlain } from "../src/domain/richText";
// React-free on purpose, so the worker test project can reach them - see web/src/lib/splitSource.ts.
import { splitSource } from "../web/src/lib/splitSource";
import {
  attrsAt, continueList, markActive, prefixActive, setAttrs, toggleMark, togglePrefix,
  type Edit, type Prefix, type Sel,
} from "../web/src/lib/richTextEdit";

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
    expect(richToPlain("***Both at once***")).toBe("Both at once");
    expect(richToPlain("__Bold__ and _soft_")).toBe("Bold and soft");
  });
  // An underscore inside a word is a word, not a marker - or every employee number and field name in the index
  // would come back with its middle eaten.
  it("leaves underscores inside words alone", () => {
    expect(richToPlain("Set first_name on EMP_0042_A today")).toBe("Set first_name on EMP_0042_A today");
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

// The composer's formatting bar. Every button is a pure transform of the source and the selection, which is what
// makes it checkable here rather than by clicking: what Bold does with the caret between two markers, or what a
// bullet does to three selected lines of one paragraph, is a statement about text.
//
// Cases are written the way they look on screen: `|` is the caret, `[...]` a selection.
function at(marked: string): [string, Sel] {
  if (marked.includes("[")) {
    const start = marked.indexOf("[");
    const end = marked.indexOf("]") - 1;
    return [marked.replace("[", "").replace("]", ""), [start, end]];
  }
  const caret = marked.indexOf("|");
  return [marked.replace("|", ""), [caret, caret]];
}
function show(e: Edit): string {
  const [s, t] = e.selection;
  if (s === t) return `${e.value.slice(0, s)}|${e.value.slice(s)}`;
  return `${e.value.slice(0, s)}[${e.value.slice(s, t)}]${e.value.slice(t)}`;
}
const mark = (marked: string, marker: string) => show(toggleMark(...at(marked), marker));
const prefix = (marked: string, kind: Prefix) => show(togglePrefix(...at(marked), kind));
const enter = (marked: string) => {
  const [value, sel] = at(marked);
  const edit = continueList(value, sel[0]);
  return edit ? show(edit) : null;
};

describe("inline marks", () => {
  it("wraps a selection and unwraps it again", () => {
    expect(mark("say [hello] there", "**")).toBe("say **[hello]** there");
    expect(mark("say **[hello]** there", "**")).toBe("say [hello] there");
  });

  it("unwraps whether the markers are selected or only hugging the words", () => {
    expect(mark("say [**hello**] there", "**")).toBe("say [hello] there");
  });

  it("opens an empty pair at the caret, and closes it when pressed again", () => {
    expect(mark("|", "**")).toBe("**|**");
    expect(mark("**|**", "**")).toBe("|");
    expect(mark("|", "*")).toBe("*|*");
    expect(mark("*|*", "*")).toBe("|");
  });

  // Emphasis is a run of one character, so the two buttons have to count it rather than match it - `*` is the
  // tail of `**`, and matching alone cannot tell those apart.
  it("stacks bold and italic instead of eating each other", () => {
    expect(mark("**|**", "*")).toBe("***|***");
    expect(mark("***|***", "*")).toBe("**|**");
    expect(mark("***|***", "**")).toBe("*|*");
    expect(mark("**[bold]**", "*")).toBe("***[bold]***");
    expect(mark("***[both]***", "**")).toBe("*[both]*");
  });

  it("reports what the caret is already inside", () => {
    expect(markActive("**bold**", [2, 6], "**")).toBe(true);
    expect(markActive("**bold**", [2, 6], "*")).toBe(false); // bold is not italic
    expect(markActive("***both***", [3, 7], "*")).toBe(true);
    expect(markActive("***both***", [3, 7], "**")).toBe(true);
    expect(markActive("plain", [0, 5], "**")).toBe(false);
  });

  it("toggles strikethrough on its own two characters", () => {
    expect(mark("[gone]", "~~")).toBe("~~[gone]~~");
    expect(mark("~~[gone]~~", "~~")).toBe("[gone]");
  });
});

describe("line prefixes", () => {
  // The bug this is here for: a bullet used to grow out to the whole paragraph, so selecting two lines of four
  // bulleted all four.
  it("bullets only the lines the selection touches", () => {
    expect(prefix("[one\ntwo\n]three\nfour", "ul")).toBe("- [one\n- two\n]three\nfour");
  });

  it("numbers each selected line in turn", () => {
    expect(prefix("[one\ntwo\nthree]", "ol")).toBe("1. [one\n2. two\n3. three]");
  });

  it("quotes and unquotes the caret's own line", () => {
    expect(prefix("one\ntw|o\nthree", "quote")).toBe("one\n> tw|o\nthree");
    expect(prefix("one\n> tw|o\nthree", "quote")).toBe("one\ntw|o\nthree");
  });

  it("removes the prefix only when every selected line already has it", () => {
    expect(prefix("[- one\ntwo]", "ul")).toBe("[- one\n- two]");
    expect(prefix("[- one\n- two]", "ul")).toBe("[one\ntwo]");
  });

  it("swaps one marker for another rather than stacking them", () => {
    expect(prefix("[- one]", "ol")).toBe("1. [one]");
    expect(prefix("[1. one]", "quote")).toBe("> [one]");
    expect(prefix("[> one]", "h")).toBe("## [one]");
  });

  it("keeps the caret with its words rather than shifting it by the whole edit", () => {
    // Three lines gain two characters each; a caret in the first has moved two, not six.
    expect(prefix("o|ne\ntwo\nthree", "ul")).toBe("- o|ne\ntwo\nthree");
    expect(prefix("[o]ne\ntwo\nthree", "ul")).toBe("- [o]ne\ntwo\nthree");
  });

  it("starts a list on the blank line the caret is parked on", () => {
    expect(prefix("Done.\n\n|", "ul")).toBe("Done.\n\n- |");
  });

  it("leaves the blank lines between paragraphs unbulleted", () => {
    expect(prefix("[one\n\ntwo]", "ul")).toBe("- [one\n\n- two]");
  });

  it("reports what the caret's line already is", () => {
    expect(prefixActive("- one", [3, 3], "ul")).toBe(true);
    expect(prefixActive("- one", [3, 3], "ol")).toBe(false);
    expect(prefixActive("- one\ntwo", [0, 9], "ul")).toBe(false); // not every line
  });
});

describe("Enter inside a list", () => {
  it("opens the next item", () => {
    expect(enter("- one|")).toBe("- one\n- |");
    expect(enter("* one|")).toBe("* one\n* |");
  });

  it("carries a number on", () => {
    expect(enter("1. one|")).toBe("1. one\n2. |");
    expect(enter("9) nine|")).toBe("9) nine\n10) |");
  });

  it("continues a quote", () => {
    expect(enter("> quoted|")).toBe("> quoted\n> |");
  });

  it("keeps the indent", () => {
    expect(enter("  - one|")).toBe("  - one\n  - |");
  });

  it("splits an item when the caret is inside it", () => {
    expect(enter("- one| two")).toBe("- one\n- | two");
  });

  it("ends the list on an empty item", () => {
    expect(enter("- one\n- |")).toBe("- one\n|");
    expect(enter("1. one\n2. |")).toBe("1. one\n|");
  });

  it("stays out of the way everywhere else", () => {
    expect(enter("just prose|")).toBe(null);
    expect(enter("|")).toBe(null);
    expect(enter("-| one")).toBe(null); // the caret is inside the marker: that Enter is a newline
  });
});

describe("block attributes", () => {
  it("writes an attribute line above the block the caret is in", () => {
    expect(setAttrs("one\n\ntwo", [6, 6], { align: "center" }).value).toBe("one\n\n{center}\ntwo");
  });

  it("merges into the line that is already there, and drops it when nothing is left", () => {
    expect(setAttrs("{center}\none", [11, 11], { size: "lg" }).value).toBe("{center lg}\none");
    expect(setAttrs("{center}\none", [11, 11], { align: undefined }).value).toBe("one");
  });

  it("reads back the attributes governing the caret", () => {
    expect(attrsAt("{center lg}\none", [13, 13])).toEqual({ align: "center", size: "lg" });
    expect(attrsAt("one", [1, 1])).toEqual({});
  });

  it("sets every block the selection spans, and leaves the caret in place", () => {
    const edit = setAttrs("one\n\ntwo", [0, 8], { align: "right" });
    expect(edit.value).toBe("{right}\none\n\n{right}\ntwo");
    expect(edit.value.slice(edit.selection[0], edit.selection[1])).toBe("one\n\n{right}\ntwo");
  });
});
