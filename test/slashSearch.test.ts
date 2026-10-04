import { describe, it, expect } from "vitest";
import { withSlashHint } from "../web/src/lib/slashSearch";

describe("withSlashHint", () => {
  it("names the key right after the leading verb", () => {
    expect(withSlashHint("Search people…")).toBe("Search (/) people…");
    expect(withSlashHint("Filter collections…")).toBe("Filter (/) collections…");
    expect(withSlashHint("Find a person")).toBe("Find (/) a person");
    expect(withSlashHint("Search…")).toBe("Search (/)…");
  });

  it("puts it at the end of a placeholder that does not lead with one", () => {
    expect(withSlashHint("Type a name")).toBe("Type a name (/)");
    expect(withSlashHint("Searching…")).toBe("Searching… (/)");
  });
});
