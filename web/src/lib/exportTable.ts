// Cross-module table export. Given header labels + a matrix of cell values (already access-filtered + row-scoped
// upstream by the API, and column-filtered by the table), emit a CSV or .xlsx download. Pure client-side - the
// data is whatever the caller could already read; who may export at all is gated by the `export` capability.
type Cell = string | number | boolean | null | undefined;

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

export async function exportTable(filename: string, headers: string[], rows: Cell[][], format: "csv" | "xlsx") {
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
