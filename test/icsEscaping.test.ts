/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { buildIcs, buildTimedIcs } from "../src/lib/ics";
import serverIcs from "../src/lib/ics.ts?raw";
import clientIcs from "../web/src/lib/ics.ts?raw";

// AN ICS TEXT VALUE IS ATTACKER-ADJACENT TEXT ON AN UNAUTHENTICATED SURFACE.
//
// `routes/holidayFeed.ts` publishes holiday names on a long-lived URL people paste into Google Calendar and
// Outlook - no session, by design. The same escape carries interview summaries and locations into candidate
// invitation mail. So whatever reaches SUMMARY/DESCRIPTION/LOCATION must not be able to end the content line.
//
// It could: the escape read `\r?\n`, which collapses CRLF and bare LF and leaves a LONE CARRIAGE RETURN
// untouched. Lines here are CRLF-delimited and parsers in the wild accept a bare CR as a break, so a name
// carrying one injected whole properties into the VEVENT.
const DAY = { uid: "u1", start: "2026-01-14", end: "2026-01-14" };

describe("ics text escaping ends no line", () => {
  it.each([
    ["a lone carriage return", "Diwali\rDESCRIPTION:injected"],
    ["a lone line feed", "Diwali\nDESCRIPTION:injected"],
    ["a CRLF pair", "Diwali\r\nDESCRIPTION:injected"],
  ])("neutralises %s", (_label, summary) => {
    const ics = buildIcs([{ ...DAY, summary }], "Holidays", 0);
    // One SUMMARY, and no second property smuggled in behind it.
    expect(ics.match(/\r\nSUMMARY:/g)).toHaveLength(1);
    expect(ics).not.toMatch(/\r\nDESCRIPTION:injected/);
    expect(ics).toContain("SUMMARY:Diwali\\nDESCRIPTION:injected");
  });

  it("escapes the delimiters and the backslash itself, in that order", () => {
    const ics = buildIcs([{ ...DAY, summary: String.raw`Back\slash; comma, done` }], "Holidays", 0);
    expect(ics).toContain(String.raw`SUMMARY:Back\\slash\; comma\, done`);
  });

  // The timed builder carries LOCATION too, which an interviewer types.
  it("neutralises a break in a timed event's location", () => {
    const ics = buildTimedIcs(
      [{ uid: "u2", start: "2026-01-14T09:00:00Z", end: "2026-01-14T10:00:00Z", summary: "Interview", location: "Room 4\rX-EVIL:1" }],
      "Interviews",
      0,
    );
    expect(ics).not.toMatch(/\r\nX-EVIL:/);
    expect(ics).toContain("LOCATION:Room 4\\nX-EVIL:1");
  });

  // The client builds its own .ics for the one-shot download. Two copies of an escape is how one of them ends
  // up without the fix (the same argument lib/winAnsi.ts makes for being shared), so they are held together.
  it("the browser's mirror escapes identically", () => {
    const escOf = (src: string) => /const esc = \(s: string\) =>(.*)/.exec(src)?.[1];
    expect(escOf(clientIcs)).toBe(escOf(serverIcs));
  });
});
