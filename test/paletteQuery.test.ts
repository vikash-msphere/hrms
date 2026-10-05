import { describe, it, expect } from "vitest";
import {
  applyFacetPick, applySuggestion, collectionsNamedBy, editDistance, facetOf, facetOffers, filtersForWords, handleFor, highlightParts, highlightTokens, isNarrowed,
  looksLikeQuestion, nearPeople, parsePaletteQuery, pushRecent, rankKindOffers, searchParams, suggestFilters, tokenAt, whenCounts, whenPresets,
  type Facet, type FilterContext, type FilterVocabulary, type KindSignals,
} from "../web/src/lib/paletteQuery";
import { collectionsOnRoute } from "../web/src/lib/resourceRoute";

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

  it("marks an in: offer whose name starts with the typed letters, not one where a later word does", () => {
    const offers = suggestFilters("in:", 3, ctx)!.items;
    expect(offers.some((s) => s.kind === "in" && s.prefix)).toBe(false); // nothing typed: nothing to start with
    const typed = suggestFilters("in:le", 5, { ...ctx, vocabulary: [...vocabulary, { collection: "letter-templates", statuses: [] }], labelOf: (c) => labels[c] ?? "Letter templates" })!.items;
    expect(typed.map((s) => [s.token, s.kind === "in" && !!s.prefix])).toEqual([["in:leave-requests", true], ["in:letter-templates", true]]);
    const wordOnly = suggestFilters("in:req", 6, ctx)!.items;
    expect(wordOnly.map((s) => [s.token, s.kind === "in" && !!s.prefix])).toEqual([["in:leave-requests", false]]);
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

  it("reads a box that starts with ? as a question about the filters alone, narrowed by what follows", () => {
    // The whole box is the span, wherever the caret is, so taking a row replaces all of it.
    expect(suggestFilters("? date", 1, ctx)).toMatchObject({ start: 0, end: 6 });
    expect(tokens("?created")).toEqual(["after:", "before:", "on:", "during:"]);
    expect(tokens("  ? person")).toEqual(["@"]);
    // Every word must match, and the words are not filters: `? is:mine` finds the filter, it does not use it up.
    expect(tokens("? records status")).toEqual(["status:"]);
    expect(tokens("? is:mine")).toEqual(["is:"]);
    expect(tokens("?zzz")).toEqual([]);
    expect(applySuggestion("? date", { start: 0, end: 6 }, "after:")).toEqual({ query: "after:", caret: 6 });
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

  it("completes a bare @ to you, your team and your reports, before a letter is typed", () => {
    const self = { reports: [people[2]!] }; // Alice Kapoor reports to the caller
    expect(tokens("@", 1, { ...ctx, self })).toEqual(["is:mine", "is:team", "@alice"]);
    expect(tokens("@", 1, { ...ctx, self: { reports: [] } })).toEqual(["is:mine"]); // no team to offer
    expect(tokens("-@", 2, { ...ctx, self })).toEqual(["-is:mine", "-is:team", "-@alice"]);
    expect(tokens("is:mine @", 9, { ...ctx, self })).toBeNull(); // an owner is already there
    expect(tokens("-is:mine -@", 11, { ...ctx, self })).toEqual(["-is:team", "-@alice"]);
    expect(tokens("@", 1, { ...ctx, self: null })).toBeNull(); // no employee record: nobody is "you"
  });
});

describe("the filter bar", () => {
  const vocabulary: FilterVocabulary = [
    { collection: "leave-requests", statuses: ["pending", "approved"] },
    { collection: "leave-types", statuses: [] },
    { collection: "tickets", statuses: ["open", "in_progress", "pending"] },
    { collection: "holidays", statuses: [] },
  ];
  const labels: Record<string, string> = { "leave-requests": "Leave requests", "leave-types": "Leave types", tickets: "Tickets", holidays: "Holidays" };
  const kinds = vocabulary.map((v) => v.collection);
  type Person = (typeof people)[number];
  // Alice Kapoor reports to the caller; the org-local day is Monday 5 October 2026.
  const ctx: FilterContext<Person> = { people, vocabulary, labelOf: (c) => labels[c]!, today: "2026-10-05", daysAgo30: "2026-09-05", self: { reports: [people[2]!] } };
  const offers = (facet: Facet, raw: string, leaveOut = false, over: Partial<FilterContext<Person>> = {}) =>
    facetOffers(facet, raw, { ...ctx, ...over, leaveOut }).map((o) => `${o.suggestion.token}${o.pressedBy.length ? "*" : ""}`);
  const words = (raw: string, over: Partial<FilterContext<Person>> & { scope?: string[] } = {}) =>
    filtersForWords(raw, { ...ctx, kinds, ...over }).map((w) => [w.words, w.suggestion.token]);

  it("knows which key a filter word belongs to, and which words are not filters", () => {
    expect(facetOf("in:tickets")).toEqual({ facet: "kind", negate: false });
    expect(facetOf("-@priya")).toEqual({ facet: "who", negate: true });
    expect(facetOf("IS:mine")).toEqual({ facet: "who", negate: false });
    expect(facetOf("during:2026")).toEqual({ facet: "when", negate: false });
    expect(facetOf("sort:new")).toEqual({ facet: "sort", negate: false });
    // No - form for the dates and the order; a bare key, a bare @ and a plain word are not filters yet.
    for (const w of ["-after:7d", "-sort:new", "status:", "@", "laptop", "constructor:x"]) expect(facetOf(w)).toBeNull();
  });

  it("offers a key's choices with the ones already in the box pressed, never left out as used", () => {
    expect(offers("kind", "laptop in:tickets")).toEqual(["in:holidays", "in:leave-requests", "in:leave-types", "in:tickets*"]);
    // A word naming several kinds presses each of them.
    expect(offers("kind", "in:leave")).toEqual(["in:holidays", "in:leave-requests*", "in:leave-types*", "in:tickets"]);
    expect(offers("status", "status:pending laptop")).toEqual(["status:pending*", "status:approved", "status:in_progress", "status:open"]);
    // A category's in: words, passed in, scope the statuses.
    expect(offers("status", "laptop in:leave-requests")).toEqual(["status:approved", "status:pending"]);
    const departments = [{ name: "Engineering" }, { name: "Sales" }];
    expect(offers("dept", "dept:Sales", false, { departments })).toEqual(["dept:engineering", "dept:sales*"]);
    expect(offers("when", "laptop after:7d")).toEqual(whenPresets(ctx.today).map((p) => (p.token === "after:7d" ? `${p.token}*` : p.token)));
  });

  it("offers the - form when leaving out, never what the box keeps", () => {
    expect(offers("kind", "in:tickets -in:holidays", true)).toEqual(["-in:holidays*", "-in:leave-requests", "-in:leave-types"]);
    expect(offers("status", "-status:open", true)).toEqual(["-status:pending", "-status:approved", "-status:in_progress", "-status:open*"]);
    expect(offers("who", "is:mine", true)).toEqual(["-is:team", "-@alice"]);
    expect(offers("when", "", true)).toEqual(whenPresets(ctx.today).map((p) => p.token)); // no - form: kept as is
  });

  it("offers you, your team and your reports for Who, with anybody already named", () => {
    expect(offers("who", "")).toEqual(["is:mine", "is:team", "@alice"]);
    expect(offers("who", "@priya leave")).toEqual(["is:mine", "is:team", "@priya*", "@alice"]);
    expect(offers("who", "", false, { self: { reports: [] } })).toEqual(["is:mine"]);
    expect(offers("who", "", false, { self: null })).toEqual([]);
    // Left out, a person is not offered as the owner.
    expect(offers("who", "-@alice")).toEqual(["is:mine", "is:team"]);
  });

  it("offers nothing in the ? guide", () => {
    expect(offers("kind", "?")).toEqual([]);
    expect(words("? pending")).toEqual([]);
  });

  it("writes a press into the box: in, out again, or in place of the key's one value", () => {
    expect(applyFacetPick("laptop", { token: "in:tickets", pressedBy: [] })).toBe("laptop in:tickets ");
    expect(applyFacetPick("laptop in:tickets in:holidays", { token: "in:leave", pressedBy: [] })).toBe("laptop in:tickets in:holidays in:leave ");
    expect(applyFacetPick("laptop in:Tickets ", { token: "in:tickets", pressedBy: ["in:Tickets"] })).toBe("laptop ");
    expect(applyFacetPick("status:open laptop", { token: "status:pending", pressedBy: [] })).toBe("laptop status:pending ");
    expect(applyFacetPick("-status:open laptop", { token: "status:pending", pressedBy: [] })).toBe("-status:open laptop status:pending ");
    expect(applyFacetPick("-status:open laptop", { token: "-status:pending", pressedBy: [] })).toBe("-status:open laptop -status:pending ");
    // The dates are one window, the owners one owner.
    expect(applyFacetPick("after:7d laptop on:today", { token: "during:2026", pressedBy: [] })).toBe("laptop during:2026 ");
    expect(applyFacetPick("@priya leave", { token: "is:mine", pressedBy: [] })).toBe("leave is:mine ");
    expect(applyFacetPick("leave", { token: "sort:new", pressedBy: [] })).toBe("leave sort:new ");
    expect(applyFacetPick("leave sort:new ", { token: "sort:new", pressedBy: ["sort:new"] })).toBe("leave ");
    expect(applyFacetPick("", { token: "in:tickets", pressedBy: [] })).toBe("in:tickets ");
  });

  it("counts the results each When choice would keep, by the window the search reads it as", () => {
    const counts = whenCounts(["2026-10-05", "2026-10-04", "2026-09-30", "2026-09-01", "2025-12-31"], "2026-10-05");
    expect(Object.fromEntries(counts)).toEqual({
      "on:today": 1, "on:yesterday": 1, "after:7d": 3, "after:30d": 3, "during:2026-10": 2, "during:2026-09": 2, "during:2026": 4, "before:2026-01": 1,
    });
  });

  it("offers the filter a typed word names, by its exact name only", () => {
    expect(words("pending leave priya")).toEqual([["pending", "status:pending"], ["leave", "in:leave"], ["priya", "@priya"]]);
    expect(filtersForWords("laptop pending", { ...ctx, kinds })[0]).toMatchObject({ start: 7, end: 14, words: "pending" });
    expect(words("ticket holiday")).toEqual([["ticket", "in:tickets"], ["holiday", "in:holidays"]]);
    expect(filtersForWords("leave", { ...ctx, kinds })[0]!.suggestion).toMatchObject({ kind: "in", named: ["leave-requests", "leave-types"] });
    // Half a word, or the start of a name, names nothing.
    expect(words("pend lea pri")).toEqual([]);
    expect(words("kapoor")).toEqual([["kapoor", "@alice"]]); // a surname names the person too
    expect(words("sales", { departments: [{ name: "Sales" }] })).toEqual([["sales", "dept:sales"]]);
  });

  it("offers owners, dates and the order for the words that mean them", () => {
    expect(words("my payslips")).toEqual([["my", "is:mine"]]);
    expect(words("my team leave")).toEqual([["my team", "is:team"], ["leave", "in:leave"]]);
    expect(words("my", { self: null })).toEqual([]);
    expect(words("newest")).toEqual([["newest", "sort:new"]]);
    expect(words("today")).toEqual([["today", "on:today"]]);
    // The latest such month not after this one: in October 2026, September is this year's and November last year's.
    expect(words("september")).toEqual([["september", "during:2026-09"]]);
    expect(words("nov")).toEqual([["nov", "during:2025-11"]]);
    expect(filtersForWords("september", { ...ctx, kinds })[0]!.suggestion).toMatchObject({ kind: "date", label: "September 2026" });
    expect(words("last month")).toEqual([["last month", "during:2026-09"]]);
    expect(words("this year 2025 2027")).toEqual([["this year", "during:2026"], ["2025", "during:2025"]]);
  });

  it("offers nothing more for a key the box already sets, and scopes statuses to the kinds in play", () => {
    expect(words("pending status:open")).toEqual([]);
    expect(words("september after:7d")).toEqual([]);
    expect(words("priya is:mine")).toEqual([]);
    expect(words("leave in:leave")).toEqual([]);
    expect(words("open in:leave-requests")).toEqual([]); // leave requests are never open
    expect(words("open", { scope: ["leave-requests"] })).toEqual([]);
    expect(words("open", { scope: ["tickets"] })).toEqual([["open", "status:open"]]);
  });

  it("names a person by the shortest handle that means only them", () => {
    expect(handleFor(people[0]!, people)).toBe("priya");
    const twins = [...people, { id: "e4", first: "Priya", last: "Das" }];
    expect(handleFor(twins[0]!, twins)).toBe("priyanair");
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

describe("rankKindOffers", () => {
  // In the alphabetical order suggestFilters hands them over.
  const offers = ["attendance", "automations", "employees", "leave-requests", "notifications", "tickets"].map((collection) => ({ collection }));
  const none: KindSignals = { pageKinds: new Set(), affinity: new Map(), reference: new Set(["automations", "notifications"]) };
  const order = (s: KindSignals, o: readonly { collection: string; prefix?: true }[] = offers) => rankKindOffers(o, s).map((r) => r.offer.collection);

  it("puts somebody's records before catalogs and the inbox, then the most findable first, then alphabetical", () => {
    // Attendance's untitled punches are not in the totals at all (migration 0011), and automations are a
    // catalog however many there are.
    const totals = new Map([["automations", 119], ["notifications", 33], ["employees", 13], ["tickets", 4]]);
    expect(order({ ...none, totals })).toEqual(["employees", "tickets", "attendance", "leave-requests", "automations", "notifications"]);
    // Nothing counted yet: records first, alphabetical within.
    expect(order(none)).toEqual(["attendance", "employees", "leave-requests", "tickets", "automations", "notifications"]);
  });

  it("ranks the page behind the search above this person's use, and their use above everything after it", () => {
    const totals = new Map([["employees", 500]]);
    const affinity = new Map([["leave-requests", 3], ["automations", 9]]);
    expect(order({ ...none, totals, affinity })).toEqual(["automations", "leave-requests", "employees", "attendance", "tickets", "notifications"]);
    expect(order({ ...none, totals, affinity, pageKinds: new Set(["tickets"]) })[0]).toBe("tickets");
  });

  it("with other words, leads with where their results are and mutes the kinds they found nothing in", () => {
    const results = { by: new Map([["tickets", 12], ["employees", 1]]), capped: true };
    const ranked = rankKindOffers(offers, { ...none, results, pageKinds: new Set(["leave-requests"]) });
    expect(ranked.map((r) => [r.offer.collection, r.count, r.muted])).toEqual([
      ["tickets", "12+", false], ["employees", "1+", false],
      ["leave-requests", "0+", true], ["attendance", "0+", true], ["automations", "0+", true], ["notifications", "0+", true],
    ]);
  });

  it("puts a name starting with the typed letters before one where a later word does, whatever the counts", () => {
    const typed = [{ collection: "leave-requests" }, { collection: "reimbursements", prefix: true as const }];
    expect(order({ ...none, totals: new Map([["leave-requests", 900], ["reimbursements", 2]]), affinity: new Map([["leave-requests", 5]]) }, typed))
      .toEqual(["reimbursements", "leave-requests"]);
  });

  it("shows the total on a bare in:, and no number for a kind the totals leave out", () => {
    const ranked = rankKindOffers(offers, { ...none, totals: new Map([["employees", 1240]]) });
    expect(ranked.find((r) => r.offer.collection === "employees")).toMatchObject({ count: (1240).toLocaleString(), muted: false });
    expect(ranked.find((r) => r.offer.collection === "tickets")).toMatchObject({ count: undefined, muted: false });
  });
});

describe("collectionsOnRoute", () => {
  it("answers the kinds a page, a settings panel or a profile tab shows", () => {
    expect([...collectionsOnRoute("/tickets")]).toEqual(["tickets"]);
    expect([...collectionsOnRoute("tickets/abc123")]).toEqual(["tickets"]);
    expect(collectionsOnRoute("/attendance")).toEqual(new Set(["attendance", "attendance-regularizations"]));
    expect(collectionsOnRoute("/settings/leave-types")).toEqual(new Set(["leave-types"]));
    expect(collectionsOnRoute("/employees/abc/leave")).toEqual(new Set(["leave-requests", "leave-encashments"]));
    expect(collectionsOnRoute("/profile/compensation")).toEqual(new Set(["reimbursements", "loans"]));
    expect(collectionsOnRoute("/employees/abc")).toEqual(new Set(["employees", "positions"]));
    expect(collectionsOnRoute("/dashboard").size).toBe(0);
  });
});
