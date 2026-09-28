import { describe, it, expect } from "vitest";
import { applySuggestion, collectionsNamedBy, editDistance, highlightParts, highlightTokens, looksLikeQuestion, nearPeople, parsePaletteQuery, pushRecent, searchParams, suggestFilters, tokenAt, type FilterVocabulary } from "../web/src/lib/paletteQuery";

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

describe("filter suggestions", () => {
  const vocabulary: FilterVocabulary = [
    { collection: "leave-requests", statuses: ["pending", "approved"] },
    { collection: "tickets", statuses: ["open", "in_progress", "pending"] },
    { collection: "holidays", statuses: [] },
  ];
  const labels: Record<string, string> = { "leave-requests": "Leave requests", tickets: "Tickets", holidays: "Holidays" };
  const ctx: Parameters<typeof suggestFilters>[2] = { people, vocabulary, labelOf: (c: string) => labels[c]!, today: "2026-09-28", daysAgo30: "2026-08-29" };
  const tokens = (raw: string, caret = raw.length, over = ctx) => suggestFilters(raw, caret, over)?.items.map((s) => s.token) ?? null;

  it("finds the word the caret is in", () => {
    expect(tokenAt("laptop in:tic", 13)).toEqual({ start: 7, end: 13, text: "in:tic" });
    expect(tokenAt("in:tic laptop", 2)).toEqual({ start: 0, end: 6, text: "in:tic" });
    expect(tokenAt("laptop ", 7)).toEqual({ start: 7, end: 7, text: "" });
  });

  it("completes in: by collection name or label, leaving out what the query already names", () => {
    expect(tokens("in:")).toEqual(["in:holidays", "in:leave-requests", "in:tickets"]);
    expect(tokens("laptop in:req")).toEqual(["in:leave-requests"]); // a word of the label
    expect(tokens("in:leave in:")).toEqual(["in:holidays", "in:tickets"]);
    expect(tokens("in:tickets")).toBeNull(); // typed out in full: Enter opens a result, not a completion
    expect(tokens("in:", 3, { ...ctx, vocabulary: null })).toBeNull(); // not loaded yet
  });

  it("completes status: from every collection, or only from the ones in: names", () => {
    expect(tokens("status:")).toEqual(["status:pending", "status:approved", "status:in_progress", "status:open"]);
    expect(tokens("status:prog")).toEqual(["status:in_progress"]);
    expect(tokens("in:leave status:")).toEqual(["status:approved", "status:pending"]);
    const pending = suggestFilters("status:pe", 9, ctx)!.items[0]!;
    expect(pending).toMatchObject({ kind: "status", collections: ["leave-requests", "tickets"] });
  });

  it("completes @name with a handle that means exactly that person", () => {
    expect(tokens("@pri")).toEqual(["@priya", "@priyanka"]);
    expect(tokens("@kap")).toEqual(["@alice"]);
    expect(tokens("@priya")).toBeNull(); // already one person, though @priyanka starts with it
    expect(tokens("@")).toBeNull(); // not the whole directory
    const twins = [...people, { id: "e4", first: "Priya", last: "Das" }];
    // Two Priyas: the first name no longer singles either out, so each gets the whole name.
    expect(tokens("@priya", 6, { ...ctx, people: twins })).toEqual(["@priyadas", "@priyanair", "@priyanka"]);
    expect(parsePaletteQuery("@priyadas", twins).owner?.id).toBe("e4");
  });

  it("completes is: and the dates", () => {
    expect(tokens("is:")).toEqual(["is:mine"]);
    expect(tokens("is:mine laptop is:")).toBeNull();
    expect(tokens("after:")).toEqual(["after:2026-09", "after:2026-08", "after:2026-08-29", "after:2026-01"]);
    expect(tokens("before:2026-0")).toEqual(["before:2026-09", "before:2026-08", "before:2026-08-29", "before:2026-01"]);
    expect(tokens("after:2026-01")).toBeNull();
  });

  it("offers nothing for a plain word", () => {
    expect(tokens("laptop")).toBeNull();
    expect(tokens("")).toBeNull();
  });

  it("swaps the word for the suggestion and puts the caret after it", () => {
    expect(applySuggestion("in:tic laptop", { start: 0, end: 6 }, "in:tickets")).toEqual({ query: "in:tickets laptop", caret: 11 });
    expect(applySuggestion("laptop @pri", { start: 7, end: 11 }, "@priya")).toEqual({ query: "laptop @priya ", caret: 14 });
  });

  it("reads back every suggestion as the filter it names", () => {
    expect(parsePaletteQuery("in:leave-requests status:in_progress @priyanka is:mine after:2026-08-29", people)).toMatchObject({
      in: ["leave-requests"], status: "in_progress", owner: people[1], mine: true, after: "2026-08-29", text: "",
    });
    expect(collectionsNamedBy("leave", ["leave-requests", "leave-types", "tickets"])).toEqual(["leave-requests", "leave-types"]);
  });
});

describe("looksLikeQuestion", () => {
  it("wants a few words or a question mark", () => {
    expect(looksLikeQuestion("laptop")).toBe(false);
    expect(looksLikeQuestion("payslip?")).toBe(true);
    expect(looksLikeQuestion("claim my internet bill")).toBe(true);
  });
});
