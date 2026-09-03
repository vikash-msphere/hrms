// Cross-module table export. Given header labels + a matrix of cell values (already access-filtered + row-scoped
// upstream by the API, and column-filtered by the table), emit a CSV or .xlsx download. The file itself is built
// client-side - the data is whatever the caller could already read; who may export at all is gated by the
// `export` capability - but the ACT is recorded server-side (see `record` below).
import { api } from "@/api";

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

export async function exportTable(filename: string, headers: string[], rows: Cell[][], format: "csv" | "xlsx", collection?: string) {
  // Awaited before the file is produced, so an export and its entry cannot be separated by the user closing
  // the tab on a download that had not been logged yet.
  await record(collection ?? filename, format, rows.length, headers);
  if (format === "csv") {
    const esc = (v: Cell) => {
      const s = v == null ? "" : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    // Prepend a BOM so Excel reads UTF-8 (accents, ₹, etc.) correctly.
    downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }), `${filename}.csv`);
  } else {
    // Lazy-load SheetJS only when an Excel export is actually requested (keeps it out of the main bundle).
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => r.map((c) => (c == null ? "" : c)))]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Export");
    XLSX.writeFile(wb, `${filename}.xlsx`);
  }
}
