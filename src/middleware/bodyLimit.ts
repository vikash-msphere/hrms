import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { MAX_DOCUMENT_BYTES, bodyTooLarge } from "../services/documentsCommon";

// Request-body ceiling for the whole API, enforced from the DECLARED length before any handler reads the body.
//
// Why it lives here and not in the upload routes: fourteen routes read a whole body (documents, Form 16,
// photos, signatures, receipts, resumes, ticket attachments, bank-format templates...) and a per-route cap has
// to be remembered fourteen times - it was remembered three. Worse, even where it was remembered it ran on
// `bytes.byteLength`, i.e. AFTER the payload had been committed to isolate memory, and the docstore's AES pass
// then copies it a second time. Cloudflare admits bodies far larger than anything this app wants against a
// 128 MiB isolate, so "reject once the buffer exists" is not a cap, it is a report.
//
// Checking `Content-Length` costs nothing and never touches the stream. A chunked body declares no length and
// passes here - which is why no body in the app is read to the end any more: every one of them goes through
// `readCappedBody` / `requireCappedBody` (services/documentsCommon.ts), which abandons the read at the cap.
// This header check is the cheap half that refuses an oversized body before even one chunk is pulled.
//
// The limit is the document cap: it is the largest thing the product accepts anywhere, so nothing legitimate
// sits above it, and one number is easier to keep true than fourteen.
export const bodyLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const declared = c.req.header("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_DOCUMENT_BYTES) throw bodyTooLarge();
  }
  await next();
};
