// The one place a file name becomes a `Content-Disposition` header.
//
// Every download route used to interpolate its name straight into the header, and most of those names come from
// somewhere a person typed: an employee's legal name on a payslip, a candidate's name on an offer letter, an
// uploaded file name. A name carrying a double quote closes the quoted-string early (the browser then saves
// something truncated or unexpected), and a CR/LF makes the Workers `Headers` constructor throw, which turns a
// download into a 500. Neither is exotic - "O'Brien" is fine, `Bob "Bobby" Smith` is not.
//
// Two parameters, deliberately: `filename` is stripped to printable ASCII for the widest client support, and
// `filename*` carries the real UTF-8 name (RFC 5987) so a Devanagari or accented name survives in every modern
// browser. Clients that understand both prefer the starred one.
const strip = (name: string): string => name.replace(/["\\\r\n]/g, "").trim();

/** `attachment` (save it) or `inline` (render it in place - PDFs the app shows in a viewer). */
export type Disposition = "attachment" | "inline";

export function contentDisposition(kind: Disposition, fileName: string): string {
  const safe = strip(fileName) || "download";
  return `${kind}; filename="${safe.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
