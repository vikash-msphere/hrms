// Shared document helpers for org-documents + personal-documents. NO access control here - the middleware
// gates both resources by path + grants (prime directive: private by default). These are pure data/IO bits.
import { invalidArgument } from "../lib/errors";

export const VALID_DOC_TYPES = ["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "FORM16", "INSURANCE", "OTHER"] as const;

// Hard cap on any document/Form-16 upload. The body is buffered whole (arrayBuffer) then AES-encrypted (a
// second full copy) before it reaches R2, so an uncapped upload is a memory + storage DoS. 25 MiB covers real
// HR documents with margin.
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/**
 * Backstop on the bytes actually read.
 *
 * The real cap is middleware/bodyLimit.ts, which refuses an oversized body from its `Content-Length` before any
 * handler reads it - that ordering is the point, because `arrayBuffer()` commits the whole payload to isolate
 * memory and the docstore's AES pass then copies it again, so a check on `byteLength` alone fires after the
 * memory it was protecting has already been spent. What is left for this function is the one case the header
 * cannot answer: a chunked body, which declares no length.
 */
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

// Extension implied by a stored content type, for rows that carry no uploaded file name (generated letters,
// signed acknowledgement copies). Only the types the app itself produces or allows on upload.
const EXT_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

// The name a document is saved under. Rows created by the app (a generated letter, a signed policy copy) have
// no uploaded file name, so the title carries the identity - it needs the extension appended or the browser/OS
// saves an extensionless file. Slashes are stripped: the name lands in Content-Disposition and on disk.
export function documentFileName(row: { fileName?: string | null; title?: string | null; contentType?: string | null }): string {
  const ext = EXT_BY_TYPE[(row.contentType ?? "").toLowerCase().split(";")[0]!.trim()];
  const base = (row.fileName || row.title || "document").replace(/[/\\]/g, "-").trim();
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(base);
  return hasExt || !ext ? base : `${base}.${ext}`;
}

export type DocumentInput = {
  document_type?: string;
  display_name?: string;
  content_type?: string | null;
  size_bytes?: number | null;
  expire_time?: string | null;
};
