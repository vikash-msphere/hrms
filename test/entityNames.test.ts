import { describe, it, expect } from "vitest";
import { collectionsNamed, entityLabel, entityLabelSingular, namesOf } from "../src/domain/entityNames";
import { SEARCH_INDEX } from "../src/domain/searchIndex";

const all = SEARCH_INDEX.map((e) => e.collection);
const named = (word: string) => collectionsNamed(word, all).sort();

describe("collectionsNamed", () => {
  it("takes the word the app shows, not only the wire name", () => {
    expect(named("tasks")).toEqual(["cards"]);
    expect(named("task")).toEqual(["cards"]);
    expect(named("cards")).toEqual(["cards"]);
    expect(named("people")).toEqual(["employees"]);
    expect(named("workflows")).toEqual(["automations"]);
    expect(named("scorecard")).toEqual(["interview-feedback"]);
  });

  it("takes the singular or the plural, either way round", () => {
    expect(named("ticket")).toEqual(["ticket-checklists", "tickets"]); // and, by its start, the checklists
    expect(named("holiday")).toEqual(["holidays"]);
    expect(named("documents")).toEqual(["org-documents", "personal-documents"]);
    expect(named("delegations")).toEqual(["approval-delegations"]);
  });

  it("takes the start of a name from three letters, and nothing shorter", () => {
    expect(named("leave")).toEqual(["leave-encashments", "leave-requests", "leave-types"]);
    expect(named("doc")).toEqual(["org-documents", "personal-documents"]);
    expect(named("ta")).toEqual([]);
    expect(named("")).toEqual([]);
  });

  it("accepts every word the app shows for a searchable collection", () => {
    // The point of sharing one table: a label on screen that `in:` did not take is the bug this replaced.
    for (const c of all) {
      expect(collectionsNamed(entityLabel(c), all), `${c} by "${entityLabel(c)}"`).toContain(c);
      expect(collectionsNamed(entityLabelSingular(c), all), `${c} by "${entityLabelSingular(c)}"`).toContain(c);
      expect(namesOf(c)).toContain(c);
    }
  });
});
