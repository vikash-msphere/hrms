import { describe, it, expect } from "vitest";
import { contentDisposition } from "../src/http/contentDisposition";
import { toComplianceEventResource } from "../src/http/serialize";

// Two things the outbound edge computes from a stored value, each of which was quietly wrong about a boundary.

// DUE TODAY IS NOT OVERDUE.
//
// `compliance_events.due_date` is a date-only column: services/complianceEvents.ts parses "YYYY-MM-DD" by
// appending `T00:00:00Z`, so the stored instant is UTC MIDNIGHT of the due day. The serializer compared it
// against the current INSTANT, which makes a filing overdue from the first millisecond of the day it is due -
// a statutory deadline painted red, with a penalty implied, on the morning somebody still has all day to meet
// it. The app disagreed with itself about it inside one dialog: web/src/pages/Compliance.tsx computes its own
// hint in calendar days and says "Due today." beside the badge this flag was driving.
describe("a compliance filing is overdue only once its due day has passed", () => {
  const day = (offsetDays: number) => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + offsetDays * 86_400_000);
  };
  const event = (dueDate: Date, status = "pending") =>
    toComplianceEventResource({
      uuid: "x", createdAt: 0, updatedAt: 0, title: "PF return", frequency: "monthly", dueDate, status,
    }) as { overdue?: boolean };

  it("is not overdue on the due day itself, at any hour of it", () => {
    expect(event(day(0)).overdue).toBeUndefined();
  });

  it("is overdue once the due day is behind us", () => {
    expect(event(day(-1)).overdue).toBe(true);
    expect(event(day(-30)).overdue).toBe(true);
  });

  it("is not overdue while the due day is still ahead", () => {
    expect(event(day(1)).overdue).toBeUndefined();
  });

  // Overdue is about an OUTSTANDING obligation. A filing that has been made, or waived, is finished whenever
  // its deadline was.
  it("is never overdue once it has been filed or waived, however late", () => {
    expect(event(day(-90), "filed").overdue).toBeUndefined();
    expect(event(day(-90), "waived").overdue).toBeUndefined();
  });
});

// `filename*` IS NOT `encodeURIComponent`.
//
// RFC 8187's `ext-value` is `charset'language'value`, and the value may hold only `attr-char` unescaped.
// `encodeURIComponent` deliberately leaves `!'()*~` alone, and four of those are not `attr-char`. The
// apostrophe is the one that bites: it is the parameter's own delimiter, so a name like `O'Brien - offer.pdf`
// produced a value carrying a third `'` and left a parser to decide which two were structure. A strict one is
// entitled to drop the parameter entirely, falling back to the ASCII `filename` - where the same name is
// already stripped down. That is the apostrophe case the module header names as the reason it exists.
describe("Content-Disposition", () => {
  const starred = (h: string) => h.match(/filename\*=UTF-8''(.*)$/)![1]!;
  const plain = (h: string) => h.match(/filename="([^"]*)"/)![1]!;

  it("percent-encodes the apostrophe, so the value carries no third delimiter", () => {
    const h = contentDisposition("attachment", "O'Brien - offer.pdf");
    expect(starred(h)).not.toContain("'");
    expect(starred(h)).toBe("O%27Brien%20-%20offer.pdf");
    expect(decodeURIComponent(starred(h))).toBe("O'Brien - offer.pdf");
  });

  it("percent-encodes the other three non-attr-char marks encodeURIComponent leaves raw", () => {
    const h = contentDisposition("attachment", "a(1)*b.pdf");
    expect(starred(h)).toBe("a%281%29%2Ab.pdf");
    expect(decodeURIComponent(starred(h))).toBe("a(1)*b.pdf");
  });

  it("round-trips a non-Latin name through the starred parameter", () => {
    const h = contentDisposition("inline", "वेतन पर्ची.pdf");
    expect(decodeURIComponent(starred(h))).toBe("वेतन पर्ची.pdf");
    expect(plain(h)).toBe("____ _____.pdf"); // the ASCII fallback, one underscore per unencodable character
  });

  it("still strips the characters that would break the header outright", () => {
    // A quote closes the quoted string early; a CR/LF makes the Workers `Headers` constructor throw.
    const h = contentDisposition("attachment", 'Bob "Bobby" Smith\r\n.pdf');
    expect(h).not.toContain("\r");
    expect(h).not.toContain("\n");
    expect(plain(h)).toBe("Bob Bobby Smith.pdf");
  });

  it("falls back to a name rather than emitting an empty one", () => {
    expect(plain(contentDisposition("attachment", '"""'))).toBe("download");
  });
});

// AND NOBODY HAND-WRITES THE HEADER.
//
// The module above exists because a file name is a value somebody typed, and quoting it is fiddly enough to
// get wrong once. That argument only holds while every route goes through it - and seven did not: they answered
// `"Content-Disposition": "attachment"` with no name at all, while the attachment row they had just read
// carried one. A browser handed a nameless disposition falls back to the request URL's last segment, which for
// a custom method is `<wire token>:downloadReceipt`: an extensionless file named after a token.
//
// Source-level, because the property is "nobody writes a second one" - the same shape as
// test/downloadLane.test.ts on the client side. A literal is permitted only where the name is a fixed ASCII
// constant the module itself wrote (the two design previews), which is a header with nothing variable in it.
describe("every download names its file through the one helper", () => {
  const routes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  it("no route hand-writes a Content-Disposition around a value", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(routes)) {
      if (path.endsWith("http/contentDisposition.ts")) continue;
      for (const line of src.split("\n")) {
        if (!/"Content-Disposition"\s*:/.test(line)) continue;
        if (/contentDisposition\(|attachmentDisposition\(/.test(line)) continue;
        // A constant the module wrote itself, with no interpolation: `filename="letterhead-preview.pdf"`.
        if (/"Content-Disposition"\s*:\s*'[^'`${}]*filename="[^"]+"'/.test(line)) continue;
        offenders.push(`${path.replace(/^\.\.\//, "")}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      "build it with contentDisposition()/attachmentDisposition() - a bare `attachment` makes the browser " +
        "name the file after the request URL, and an interpolated name needs the quoting this module does",
    ).toEqual([]);
  });
});
