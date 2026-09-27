import { describe, it, expect } from "vitest";
import { editDistance, highlightParts, highlightTokens, looksLikeQuestion, nearPeople, parsePaletteQuery, pushRecent, searchParams } from "../web/src/lib/paletteQuery";

const people = [
  { id: "e1", first: "Priya", last: "Nair" },
  { id: "e2", first: "Priyanka", last: "Shah" },
  { id: "e3", first: "Alice", last: "Kapoor" },
];

describe("parsePaletteQuery", () => {
  it("splits the narrowing from the words", () => {
    const q = parsePaletteQuery("in:tickets @alice laptop is:mine", people);
    expect(q).toEqual({ text: "laptop", in: ["tickets"], owner: people[2], mine: true });
    const dated = parsePaletteQuery("status:Pending after:2026-01 before:2026-03-15 leave", people);
    expect(dated).toMatchObject({ text: "leave", status: "pending", after: "2026-01", before: "2026-03-15" });
    expect(searchParams(dated)).toBe("q=leave&after=2026-01&before=2026-03-15&status=pending");
    expect(searchParams(q)).toBe("q=laptop&in=tickets&owner=employees%2Fe3&mine=1");
  });

  it("resolves @name only when it means one person, and keeps it as a word otherwise", () => {
    expect(parsePaletteQuery("@priya laptop", people).owner).toEqual(people[0]); // exact first name wins
    const vague = parsePaletteQuery("@pri laptop", people); // Priya or Priyanka
    expect(vague.owner).toBeNull();
    expect(vague.text).toBe("pri laptop");
  });
});

describe("nearPeople", () => {
  it("finds a name typed with one slip", () => {
    expect(nearPeople("kpoor", people).map((p) => p.id)).toEqual(["e3"]);
    expect(nearPeople("akpoor", people).map((p) => p.id)).toEqual(["e3"]); // transposition
  });

  it("leaves short words alone", () => {
    expect(nearPeople("nar", people)).toEqual([]);
  });

  it("stops early once the distance is past the limit", () => {
    expect(editDistance("kapoor", "zzzzzzzz", 1)).toBe(2);
  });
});

describe("highlightParts", () => {
  const marked = (text: string, q: string) => highlightParts(text, highlightTokens(q)).filter((p) => p.hit).map((p) => p.text);

  it("marks typed words where they start a word, as the index matches them", () => {
    expect(marked("Alice Kapoor", "kap ali")).toEqual(["Ali", "Kap"]);
    expect(marked("Laptop not booting", "laptop")).toEqual(["Laptop"]);
  });

  it("does not mark a typed word inside another word", () => {
    expect(marked("Mishap report", "hap")).toEqual([]);
  });

  it("keeps the whole text, in order, around the marks", () => {
    expect(highlightParts("Alice Kapoor", ["kap"]).map((p) => p.text).join("")).toBe("Alice Kapoor");
    expect(highlightParts("", ["kap"])).toEqual([{ text: "", hit: false }]);
  });
});

describe("pushRecent", () => {
  it("puts the latest first, drops a repeat whatever its case, and caps the list", () => {
    expect(pushRecent(["laptop", "payslip"], "Payslip")).toEqual(["Payslip", "laptop"]);
    expect(pushRecent(["a1", "a2", "a3"], "new", 3)).toEqual(["new", "a1", "a2"]);
    expect(pushRecent(["laptop"], " x ")).toEqual(["laptop"]); // too short to be worth offering again
  });
});

describe("looksLikeQuestion", () => {
  it("wants a few words or a question mark", () => {
    expect(looksLikeQuestion("laptop")).toBe(false);
    expect(looksLikeQuestion("payslip?")).toBe(true);
    expect(looksLikeQuestion("claim my internet bill")).toBe(true);
  });
});
