import { describe, it, expect } from "vitest";
import { applySuggestion, collectionsNamedBy, editDistance, highlightParts, highlightTokens, isNarrowed, looksLikeQuestion, nearPeople, parsePaletteQuery, pushRecent, searchParams, suggestFilters, tokenAt, type FilterVocabulary } from "../web/src/lib/paletteQuery";

const people = [
  { id: "e1", first: "Priya", last: "Nair" },
  { id: "e2", first: "Priyanka", last: "Shah" },
  { id: "e3", first: "Alice", last: "Kapoor" },
];

describe("parsePaletteQuery", () => {
  it("splits the narrowing from the words", () => {
    const q = parsePaletteQuery("in:tickets @alice laptop is:mine", people);
    expect(q).toEqual({
      text: "laptop", in: ["tickets"], notIn: [], owner: people[2], notOwners: [], mine: true, notMine: false, team: false, notTeam: false,
      notDepts: [], notStatuses: [], incomplete: false,
    });
    const dated = parsePaletteQuery("status:Pending after:2026-01 before:2026-03-15 leave", people);
    expect(dated).toMatchObject({ text: "leave", status: "pending", after: "2026-01", before: "2026-03-15" });
    expect(searchParams(dated)).toBe("q=leave&after=2026-01&before=2026-03-15&status=pending");
    expect(searchParams(q)).toBe("q=laptop&in=tickets&owner=employees%2Fe3&mine=1");
  });

  it("reads the exclusions, the team, the department and the order", () => {
    const q = parsePaletteQuery("-in:holidays -status:Rejected is:team dept:Customer-Success sort:new laptop", people);
    expect(q).toMatchObject({ text: "laptop", notIn: ["holidays"], notStatuses: ["rejected"], team: true, dept: "customer-success", sort: "new" });
    expect(isNarrowed(q)).toBe(true);
    expect(searchParams(q)).toBe("q=laptop&notin=holidays&team=1&dept=customer-success&notstatus=rejected&sort=new");
    // An order alone narrows nothing: it is still a question about the whole app.
    expect(isNarrowed(parsePaletteQuery("sort:new laptop", people))).toBe(false);
  });

  it("turns @name, is: and dept: round with a -, and mixes them with the plain filters", () => {
    const q = parsePaletteQuery("is:team -@alice -is:mine -dept:eng-platform dept:eng", people);
    expect(q).toMatchObject({ team: true, notOwners: [people[2]], notMine: true, dept: "eng", notDepts: ["eng-platform"], text: "", incomplete: false });
    expect(isNarrowed(parsePaletteQuery("-is:team", people))).toBe(true);
    expect(searchParams(q)).toBe("q=&notowner=employees%2Fe3&notmine=1&team=1&dept=eng&notdept=eng-platform");
  });

  it("takes each - filter more than once, and sends every value", () => {
    const q = parsePaletteQuery("-@alice -@priyanka -status:rejected -status:Cancelled -dept:hr -dept:eng -in:holidays -in:assets -@alice", people);
    expect(q).toMatchObject({
      notOwners: [people[2], people[1]], // the repeat of Alice counts once
      notStatuses: ["rejected", "cancelled"], notDepts: ["hr", "eng"], notIn: ["holidays", "assets"], incomplete: false,
    });
    // People repeat the param, because the server decodes each ref whole; the rest are comma lists.
    expect(searchParams(q)).toBe(
      "q=&notin=holidays%2Cassets&notowner=employees%2Fe3&notowner=employees%2Fe2&notdept=hr%2Ceng&notstatus=rejected%2Ccancelled",
    );
  });

  it("holds back a -@name that does not name one person, rather than searching for the name", () => {
    // As a plain word it would ASK for Priya's records, the opposite of what was typed.
    const vague = parsePaletteQuery("-@pri laptop", people);
    expect(vague).toMatchObject({ notOwners: [], incomplete: true, text: "laptop" });
    expect(parsePaletteQuery("-@priya laptop", people)).toMatchObject({ notOwners: [people[0]], incomplete: false });
    // A second person who IS named does not hold the query back.
    expect(parsePaletteQuery("-@priya -@alice laptop", people)).toMatchObject({ notOwners: [people[0], people[2]], incomplete: false });
  });

  it("counts relative dates back from the org's today, and turns on: and during: into a window", () => {
    const today = "2026-10-03";
    const at = (raw: string) => parsePaletteQuery(raw, people, today);
    expect(at("after:7d")).toMatchObject({ after: "2026-09-26" });
    expect(at("after:2w before:yesterday")).toMatchObject({ after: "2026-09-19", before: "2026-10-02" });
    expect(at("on:today")).toMatchObject({ after: "2026-10-03", before: "2026-10-04" });
    expect(at("on:2026-02-28")).toMatchObject({ after: "2026-02-28", before: "2026-03-01" });
    expect(at("during:2026-12")).toMatchObject({ after: "2026-12", before: "2027-01" });
    expect(at("during:2025")).toMatchObject({ after: "2025-01", before: "2026-01" });
    // Not a date: passed on as typed, so the server answers nothing rather than ignoring it.
    expect(at("on:someday")).toMatchObject({ after: "someday", before: "someday" });
    // Without a today, a relative date cannot be counted and is passed on as typed too.
    expect(parsePaletteQuery("after:7d", people)).toMatchObject({ after: "7d" });
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

  it("offers every kind after in:, not the first eight - the palette ranks them, so cutting here cut alphabetically", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ collection: `kind-${String(i).padStart(2, "0")}`, statuses: [`state${i}`] }));
    const wide = { ...ctx, vocabulary: many, labelOf: (c: string) => c };
    expect(tokens("in:", 3, wide)).toHaveLength(12);
    // Every other key keeps its cap of eight: twelve statuses, eight offered.
    expect(tokens("status:", 7, wide)).toHaveLength(8);
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
    expect(tokens("is:")).toEqual(["is:mine", "is:team"]);
    expect(tokens("is:t")).toEqual(["is:team"]);
    expect(tokens("is:mine laptop is:")).toBeNull(); // mine and my team are different owners
    expect(tokens("after:")).toEqual(["after:7d", "after:2026-09", "after:2026-08", "after:2026-08-29", "after:2026-01"]);
    expect(tokens("before:2026-0")).toEqual(["before:2026-09", "before:2026-08", "before:2026-08-29", "before:2026-01"]);
    expect(tokens("after:2026-01")).toBeNull();
    expect(tokens("on:")).toEqual(["on:today", "on:yesterday"]);
    expect(tokens("during:")).toEqual(["during:2026-09", "during:2026-08", "during:2026"]);
    expect(tokens("after:7d on:")).toBeNull(); // a window is already there
  });

  it("completes the exclusions, the department and the order", () => {
    expect(tokens("-in:hol")).toEqual(["-in:holidays"]);
    expect(tokens("in:tickets -in:")).toEqual(["-in:holidays", "-in:leave-requests"]);
    expect(suggestFilters("-in:hol", 7, ctx)!.items[0]).toMatchObject({ kind: "in", negate: true });
    expect(tokens("in:leave -status:")).toEqual(["-status:approved", "-status:pending"]);
    const departments = [{ name: "Customer Success" }, { name: "Engineering" }, { name: "Sales & Marketing" }];
    expect(tokens("dept:", 5, { ...ctx, departments })).toEqual(["dept:customer-success", "dept:engineering", "dept:sales-marketing"]);
    expect(tokens("dept:mark", 9, { ...ctx, departments })).toEqual(["dept:sales-marketing"]); // a word of the name
    expect(tokens("dept:", 5)).toBeNull(); // not loaded yet
    expect(tokens("sort:")).toEqual(["sort:new"]);
    expect(tokens("sort:new laptop sort:")).toBeNull();
  });

  it("opens the guide to every filter key on a lone ?, the - rule first, less the ones already used", () => {
    expect(tokens("?")).toEqual(["-", "in:", "@", "is:", "dept:", "status:", "after:", "before:", "on:", "during:", "sort:"]);
    const used = tokens("is:mine after:7d laptop ?")!;
    expect(used).not.toContain("is:");
    expect(used).not.toContain("on:");
    expect(used).toContain("before:");
    // Each filter that can be turned round shows its - form; the dates cannot.
    const guide = suggestFilters("?", 1, ctx)!.items;
    expect(guide.find((s) => s.token === "@")).toMatchObject({ kind: "key", leaveOut: "-@priya" });
    expect(guide.find((s) => s.token === "after:")).not.toHaveProperty("leaveOut");
    expect(guide[0]).toMatchObject({ token: "-", example: expect.stringContaining("-in: · -@ · -is: · -dept: · -status:") });
    // Mid-word it is not the guide: `laptop?` is a word with a question mark.
    expect(tokens("laptop?")).toBeNull();
  });

  it("offers on a lone - the filters it can turn round", () => {
    expect(tokens("-")).toEqual(["-in:", "-@", "-is:", "-dept:", "-status:"]);
    // Leaving one person out does not use up -@: another can follow.
    expect(tokens("-@alice laptop -")).toEqual(["-in:", "-@", "-is:", "-dept:", "-status:"]);
    expect(tokens("-is:mine -is:team -")).toEqual(["-in:", "-@", "-dept:", "-status:"]);
    // The dates and sort: have no - form.
    expect(tokens("-after:")).toBeNull();
    expect(tokens("-sort:")).toBeNull();
  });

  it("completes the - form of every filter that has one", () => {
    expect(tokens("-@kap")).toEqual(["-@alice"]);
    expect(suggestFilters("-@kap", 5, ctx)!.items[0]).toMatchObject({ kind: "person", negate: true });
    expect(tokens("-is:")).toEqual(["-is:mine", "-is:team"]);
    expect(tokens("is:team -is:")).toEqual(["-is:mine"]); // leaving out what was asked for is nothing
    const departments = [{ name: "Eng" }, { name: "Eng Platform" }];
    expect(tokens("dept:eng -dept:", 15, { ...ctx, departments })).toEqual(["-dept:eng-platform"]);
    expect(tokens("-dept:", 6, { ...ctx, departments })).toEqual(["-dept:eng", "-dept:eng-platform"]);
  });

  it("offers a second - value of the same kind, never one already named", () => {
    expect(tokens("-@alice -@pri")).toEqual(["-@priya", "-@priyanka"]);
    expect(tokens("-@priya -@pri")).toEqual(["-@priyanka"]);
    expect(tokens("@priya -@pri")).toEqual(["-@priyanka"]); // asked for, so not left out
    expect(tokens("-status:pending -status:")).toEqual(["-status:approved", "-status:in_progress", "-status:open"]);
    const departments = [{ name: "Eng" }, { name: "HR" }, { name: "Sales" }];
    expect(tokens("-dept:hr -dept:", 15, { ...ctx, departments })).toEqual(["-dept:eng", "-dept:sales"]);
  });

  it("leaves a bare key open, so its own completions follow", () => {
    expect(applySuggestion("?", { start: 0, end: 1 }, "dept:")).toEqual({ query: "dept:", caret: 5 });
    expect(applySuggestion("? laptop", { start: 0, end: 1 }, "@")).toEqual({ query: "@ laptop", caret: 1 });
    expect(applySuggestion("?", { start: 0, end: 1 }, "-")).toEqual({ query: "-", caret: 1 });
    expect(applySuggestion("-", { start: 0, end: 1 }, "-@")).toEqual({ query: "-@", caret: 2 });
    expect(tokens("dept:", 5, { ...ctx, departments: [{ name: "Sales" }] })).toEqual(["dept:sales"]);
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
    expect(parsePaletteQuery("-in:holidays -status:approved is:team dept:sales-marketing sort:new on:yesterday", people, "2026-09-28")).toMatchObject({
      notIn: ["holidays"], notStatuses: ["approved"], team: true, dept: "sales-marketing", sort: "new", after: "2026-09-27", before: "2026-09-28", text: "",
    });
    expect(collectionsNamedBy("leave", ["leave-requests", "leave-types", "tickets"])).toEqual(["leave-requests", "leave-types"]);
  });
});

describe("looksLikeQuestion", () => {
  it("wants a few words or a question mark", () => {
    expect(looksLikeQuestion("laptop")).toBe(false);
    expect(looksLikeQuestion("payslip?")).toBe(true);
    expect(looksLikeQuestion("claim my internet bill")).toBe(true);
    expect(looksLikeQuestion("?")).toBe(false); // the filter guide, not a question
  });
});
