import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { MAX_DOCUMENT_BYTES } from "../services/documentsCommon";
import { invalidArgument } from "../lib/errors";

// Request-body ceiling for the whole API, enforced from the DECLARED length before any handler reads the body.
//
// Why it lives here and not in the upload routes: fourteen routes buffer a whole body with `c.req.arrayBuffer()`
// (documents, Form 16, photos, signatures, receipts, resumes, ticket attachments, bank-format templates...) and
// a per-route cap has to be remembered fourteen times - it was remembered three. Worse, even where it was
// remembered it ran on `bytes.byteLength`, i.e. AFTER the payload had been committed to isolate memory, and the
// docstore's AES pass then copies it a second time. Cloudflare admits bodies far larger than anything this app
// wants against a 128 MiB isolate, so "reject once the buffer exists" is not a cap, it is a report.
//
// Checking `Content-Length` costs nothing and never touches the stream. A chunked body declares no length and
// passes here; the routes that already assert on the bytes they read keep doing so as the backstop for that
// case, which is the only case left.
//
// The limit is the document cap: it is the largest thing the product accepts anywhere, so nothing legitimate
// sits above it, and one number is easier to keep true than fourteen.
export const bodyLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const declared = c.req.header("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_DOCUMENT_BYTES) {
      throw invalidArgument(`request body too large (max ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MiB)`);
    }
  }
  await next();
};
