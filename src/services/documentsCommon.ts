// Shared document helpers for org-documents + personal-documents. NO access control here - the middleware
// gates both resources by path + grants (prime directive: private by default). These are pure data/IO bits.
import { invalidArgument } from "../lib/errors";

export const VALID_DOC_TYPES = ["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "FORM16", "INSURANCE", "OTHER"] as const;

// Hard cap on any document/Form-16 upload.
//
// THE BINDING CONSTRAINT IS ISOLATE MEMORY, NOT STORAGE. A Workers isolate has 128 MB and serves MANY
// concurrent requests, so this ceiling is not "how big a file do we tolerate" - it is "how big a file, times
// how many at once, before the isolate is killed and takes every unrelated in-flight request with it".
//
// One upload costs roughly three times the file: the buffered request body (`arrayBuffer`), the AES-GCM
// ciphertext, and the sealed [iv||ct] buffer handed to R2. A download costs twice: the ciphertext read back
// and the decrypted plaintext. One-shot AES-GCM cannot stream - the tag covers the whole message - so the
// second copy on each path is structural, not sloppiness.
//
// At 25 MiB that was ~75 MB for a single upload: two concurrent ones exceeded the isolate on their own, and
// the failure mode is not a 413 for the uploader, it is `Worker exceeded memory limit` for everyone the
// isolate was serving. 10 MiB puts a concurrent upload at ~30 MB, so several overlap comfortably, and it
// matches the attachment default (services/attachments.ts) so the app has one answer to "how big may a file
// be" instead of two. Raising it is a memory decision, not a product one: work out the peak first.
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** The one refusal for a request body over the cap - shared so every place that enforces it agrees on the
 *  status and the wording (middleware/bodyLimit.ts from the declared length; `readCappedBody` below from the
 *  bytes, for a body that declares none). */
export const bodyTooLarge = () =>
  invalidArgument(`request body too large (max ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MiB)`);

/**
 * Read a request OR RESPONSE body to bytes, ABANDONING the read the moment it passes `max`.
 *
 * This is the only body read in the app that is a real cap. `request.arrayBuffer()` reads to the end of the
 * stream however long that is, so a size check on the result fires after the memory it was protecting has
 * already been spent - and middleware/bodyLimit.ts cannot help, because it decides from `Content-Length` and a
 * `Transfer-Encoding: chunked` body declares none. Both checks therefore passed and the payload was committed
 * to a 128 MB isolate whole, against a 10 MiB ceiling: an authenticated caller could do it through any of the
 * fourteen upload routes, and an anonymous one through the /diag relay, which needs no credential at all.
 *
 * The stream is consumed in chunks with a running total and cancelled as soon as the total passes the cap, so
 * the bytes held are bounded by one chunk past it and the rest is never pulled.
 *
 * Returns null when the body is over the cap - the refusal is the CALLER's, because they do not agree on it:
 * an upload answers `bodyTooLarge` (400, the shared wording), the telemetry relay answers 413 in the shape its
 * client SDK understands. Use `requireCappedBody` for the former.
 *
 * Typed on the `body` stream rather than on `Request`, because a RESPONSE we did not originate needs the same
 * treatment for the same reason: the signed-document download in services/esign/cashfree.ts follows a vendor
 * redirect to somewhere the vendor chose, and `res.arrayBuffer()` there spent the isolate against a ceiling
 * checked afterwards. A `content-length` is not a cap either - the hop that matters is the one that omits it.
 */
export async function readCappedBody(request: { body: ReadableStream<Uint8Array> | null }, max: number = MAX_DOCUMENT_BYTES): Promise<ArrayBuffer | null> {
  const stream = request.body;
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return joined.buffer;
}

/** `readCappedBody` with the shared refusal already applied - what every upload route wants. */
export async function requireCappedBody(request: Request, max: number = MAX_DOCUMENT_BYTES): Promise<ArrayBuffer> {
  const body = await readCappedBody(request, max);
  if (!body) throw bodyTooLarge();
  return body;
}

/**
 * Backstop on the bytes a service was handed.
 *
 * The cap that matters is the one taken BEFORE the buffer exists: `readCappedBody` for a request body, and
 * middleware/bodyLimit.ts earlier still for one that declares its length. This is what remains for bytes that
 * did not arrive as a request body at all - a signed PDF downloaded from an e-sign vendor, say - and for a
 * caller that hands over an already-buffered array.
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

/** The bare media type: lowercased, parameters stripped.
 *
 *  A `Content-Type` may carry parameters - `image/svg+xml; charset=utf-8` is the same media type as
 *  `image/svg+xml`, and browsers and curl both send the parameterized form routinely. Every comparison below
 *  is against a bare type, so they all have to be made against this rather than against the raw header, and
 *  the exact refusals were what an unnormalized string got wrong in both directions: the SVG refusal was an
 *  `===` that a parameter walked straight past (`image/svg+xml; charset=utf-8` then matched the broad
 *  `image/` arm and was allowed), and `text/plain; charset=utf-8` - the ordinary way a .txt is sent - failed
 *  the allow arm and was refused unless the file name happened to carry an extension. */
const mediaType = (contentType?: string): string | undefined =>
  contentType?.toLowerCase().split(";")[0]!.trim() || undefined;

export function isAllowedUpload(fileName?: string, contentType?: string): boolean {
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext === "svg") return false;
  const ct = mediaType(contentType);
  // The SVG refusal comes before the extension allow-list, not after it: the media type is what the file IS,
  // and a name is only what it was called. `logo.png` declaring `image/svg+xml` is an SVG.
  if (ct === "image/svg+xml") return false;
  if (ext && ALLOWED_EXTENSIONS.has(ext)) return true;
  if (ct) {
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
  if (mediaType(contentType) === "application/pdf") return true;
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
  const ext = EXT_BY_TYPE[mediaType(row.contentType ?? undefined) ?? ""];
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
