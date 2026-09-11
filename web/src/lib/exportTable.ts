// Cross-module table export. Given header labels + a matrix of cell values (already access-filtered + row-scoped
// upstream by the API, and column-filtered by the table), emit a CSV or .xlsx download. The file itself is built
// client-side - the data is whatever the caller could already read; who may export at all is gated by the
// `export` capability - but the ACT is recorded server-side (see `record` below).
import { api } from "@/api";
import { toast } from "@/components/ui/use-toast";

type Cell = string | number | boolean | null | undefined;

/**
 * Tell the server a bulk export happened.
 *
 * Recorded HERE, inside the one function every export in the app goes through, rather than at each call site:
 * the point of an export audit is that no export escapes it, and a per-caller opt-in is a rule someone
 * eventually forgets. Shape only - the collection, the format, the row count, the column names. Never a value.
 *
 * Best-effort, and the export proceeds either way. Auditing is observability, not access control (the same
 * principle the authz middleware states), so a failed audit write must not deny somebody a report they are
 * entitled to. The cost of that choice is honest: an export whose recording call fails is an export the trail
 * does not have.
 */
async function record(collection: string, format: "csv" | "xlsx", rows: number, columns: string[]) {
  try {
    await api("/export:record", { method: "POST", body: JSON.stringify({ collection, format, rows, columns: columns.slice(0, 64) }) });
  } catch (e) {
    console.warn("[export] the export was not recorded in the audit trail", e);
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Excel, Sheets and LibreOffice read a CSV cell that STARTS with `=`, `+`, `-`, `@` (or a tab/CR) as the start
// of a FORMULA, not as text. Almost every value in this app is something a person typed - an employee's name, a
// ticket title, an expense note, a suggestion - so without this an employee can leave
// `=HYPERLINK("https://…"&A2,"Payslip")` in a field, and it becomes a live formula the moment HR opens the
// export: it renders as an ordinary link and carries the row it sits beside off to whoever is listening. The
// DDE forms (`=cmd|'/c …'!A1`) go further still.
//
// RFC-4180 quoting is NOT a defence - the parser strips the quotes and the cell still begins with `=`. So the
// value itself is prefixed with an apostrophe, which those readers treat as "this cell is literal text" and do
// not display. Plain numbers are left alone, or every negative amount in a payroll export would stop being a
// number. The .xlsx path needs none of this: SheetJS writes these values as string cells, and a formula in
// xlsx is a distinct element that a string cell can never become.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const defuse = (s: string) => (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s);

/** The CSV text for a table, RFC-4180 quoted and formula-neutralised. Separate from the download so the rule
 *  above can be pinned by a test without a DOM. */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => {
    const s = defuse(v == null ? "" : String(v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

/**
 * Produce the download. NEVER REJECTS - it reports its own failure instead.
 *
 * Same argument as `record` above: this is the one function every export in the app goes through, so the
 * handling belongs here rather than at each of the eight call sites, where it was absent at three of them and
 * the promise was simply dropped. The failure is not hypothetical - the Excel path lazy-loads SheetJS, and a
 * chunk request for a build that has since been replaced fails outright, so a click on "Export to Excel" did
 * nothing at all: no file, no message, and an unhandled rejection in the console. A person who is not watching
 * the console reads that as the button being broken.
 */
export async function exportTable(filename: string, headers: string[], rows: Cell[][], format: "csv" | "xlsx", collection?: string) {
  // Awaited before the file is produced, so an export and its entry cannot be separated by the user closing
  // the tab on a download that had not been logged yet. `record` swallows its own failure - see above.
  await record(collection ?? filename, format, rows.length, headers);
  try {
    if (format === "csv") {
      // Prepend a BOM so Excel reads UTF-8 (accents, ₹, etc.) correctly.
      downloadBlob(new Blob(["﻿" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8;" }), `${filename}.csv`);
    } else {
      // Lazy-load SheetJS only when an Excel export is actually requested (keeps it out of the main bundle).
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => r.map((c) => (c == null ? "" : c)))]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Export");
      XLSX.writeFile(wb, `${filename}.xlsx`);
    }
  } catch (e) {
    console.error("[export] the file could not be produced", e);
    toast({
      variant: "destructive",
      title: "Couldn't produce the export",
      // A failed chunk load is the common cause and is fixed by a reload, so say so rather than showing a
      // stack-shaped message nobody can act on.
      description: "Reload the page and try again - the app may have been updated since this tab was opened.",
    });
  }
}
