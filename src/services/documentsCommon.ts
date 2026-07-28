// Shared document helpers for org-documents + personal-documents. NO access control here - the middleware
// gates both resources by path + grants (prime directive: private by default). These are pure data/IO bits.
import { invalidArgument } from "../lib/errors";

export const VALID_DOC_TYPES = ["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "FORM16", "INSURANCE", "OTHER"] as const;

// Hard cap on any document/Form-16 upload. The body is buffered whole (arrayBuffer) then AES-encrypted (a
// second full copy) before it reaches R2, so an uncapped upload is a memory + storage DoS. 25 MiB covers real
// HR documents with margin.
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export function assertUploadSize(byteLength: number): void {
  if (byteLength > MAX_DOCUMENT_BYTES) throw invalidArgument(`file too large (max ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MiB)`);
}
export type DocType = (typeof VALID_DOC_TYPES)[number];

export const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Server-authoritative upload allow-list (documents, spreadsheets, presentations, images).
const ALLOWED_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "odt", "rtf", "pages", "txt", "md",
  "ppt", "pptx", "odp",
  "csv", "xls", "xlsx", "ods", "numbers",
  "png", "jpg", "jpeg", "gif", "webp", "heic",
]);
// SVG is deliberately NOT allowed: it can carry inline script and is a stored-XSS vector if ever served
// inline. (The API CSP + attachment disposition also defend, but the file type is refused outright.)

export function isAllowedUpload(fileName?: string, contentType?: string): boolean {
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext === "svg") return false;
  if (ext && ALLOWED_EXTENSIONS.has(ext)) return true;
  const ct = contentType?.toLowerCase();
  if (ct) {
    if (ct === "image/svg+xml") return false;
    if (ct.startsWith("image/")) return true;
    if (ct === "application/pdf" || ct === "text/plain" || ct.includes("rtf")) return true;
    if (/word|opendocument|msword|excel|spreadsheet|sheet|presentation|powerpoint/.test(ct)) return true;
  }
  return false;
}

// A policy that requires acknowledgement must be a PDF: the signed copy filed for each employee is the policy
// itself with an acknowledgement certificate page appended (pdf-lib can only merge PDF pages), so a non-PDF
// source could never be combined. Enforced at upload + when toggling requires_ack on.
export function isPdfUpload(fileName?: string, contentType?: string): boolean {
  if ((contentType?.toLowerCase() ?? "") === "application/pdf") return true;
  return fileName?.split(".").pop()?.toLowerCase() === "pdf";
}

export type DocumentInput = {
  document_type?: string;
  display_name?: string;
  content_type?: string | null;
  size_bytes?: number | null;
  expire_time?: string | null;
};
