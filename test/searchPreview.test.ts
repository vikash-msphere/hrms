import { describe, it, expect } from "vitest";
import { previewOf } from "../web/src/lib/searchPreview";

// What the search's preview pane says about a record (web/src/lib/searchPreview.ts): one rule for every kind,
// read off the record as the API returns it.

const names: Record<string, string> = { "employees/e1": "Priya Shah" };
const nameOf = (ref: string) => names[ref] ?? null;

describe("previewOf", () => {
  it("says the status in words, whose it is, the dates in order and the first text", () => {
    const p = previewOf(
      { state: "PENDING", employee: "employees/e1", start_date: "2026-10-12", end_date: "2026-10-14", reason: "  Family wedding  ", create_time: "2026-10-01T09:00:00Z" },
      nameOf,
    );
    expect(p.status).toBe("Pending");
    expect(p.facts.map((f) => f.label)).toEqual(["Person", "Starts", "Ends", "Created"]);
    expect(p.facts[0]!.value).toBe("Priya Shah");
    expect(p.text).toBe("Family wedding");
  });

  it("leaves out a person the caller cannot see rather than showing a bare id", () => {
    const p = previewOf({ status: "open", employee: "employees/hidden" }, nameOf);
    expect(p.facts).toEqual([]);
    expect(p.status).toBe("Open");
  });

  it("turns snake_case statuses into words and cuts long text with an ellipsis", () => {
    const p = previewOf({ status: "in_progress", description: "x".repeat(800) }, nameOf);
    expect(p.status).toBe("In progress");
    expect(p.text!.length).toBe(601);
    expect(p.text!.endsWith("…")).toBe(true);
  });

  it("has nothing to say about a record with none of the fields it reads", () => {
    expect(previewOf({ title: "Something" }, nameOf)).toEqual({ status: null, facts: [], text: null });
  });
});
