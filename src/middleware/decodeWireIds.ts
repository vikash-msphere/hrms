// Inbound edge: the wire speaks idCodec tokens; the app speaks internal ids. This runs BEFORE Hono
// routes, rewriting the request so the path's resource token and any `<collection>/<token>` refs in a
// JSON body become internal ids. After this, c.req.param(), the authz middleware, and every service
// work on internal ids exactly as before - no per-handler decode. The symmetric outbound half is
// encodeWireIds.ts. A forged/foreign/malformed token does not decode and is left as-is, so it simply
// fails downstream (not found / invalid), never resolving to another object.
import { ENCODABLE } from "./encodeWireIds";
import { isJsonBody } from "../http/jsonRequest";
import { MAX_DOCUMENT_BYTES, requireCappedBody } from "../services/documentsCommon";
import type { IdCodec } from "../lib/idCodec";

const TOKEN = "[0-9a-hj-km-np-tv-z]{26}"; // a wire token (encrypted 8-byte id -> 26 base32 chars)
const BODY_REF_RE = new RegExp(`^([a-z][a-z-]*)\\/(${TOKEN})$`);

// Rewrite the top resource id token in /v1/<collection>/<token>[...] -> internal id. `me`, `-`, and a
// trailing :verb are preserved; sub-resource segments (e.g. /bank-account) are untouched.
async function decodePathname(pathname: string, codec: IdCodec): Promise<string> {
  const m = /^\/v1\/(.+)$/.exec(pathname);
  if (!m) return pathname;
  const segs = m[1]!.split("/");
  const collection = segs[0]!;
  if (segs.length < 2 || !ENCODABLE.has(collection)) return pathname;
  let idSeg = segs[1]!;
  let verb = "";
  const ci = idSeg.indexOf(":");
  if (ci >= 0) {
    verb = idSeg.slice(ci); // includes ':'
    idSeg = idSeg.slice(0, ci);
  }
  if (idSeg === "me" || idSeg === "-" || !new RegExp(`^${TOKEN}$`).test(idSeg)) return pathname;
  const internal = await codec.decode(collection, idSeg);
  if (!internal) return pathname; // forged/foreign/tampered -> leave; downstream 404s
  segs[1] = internal + verb;
  return `/v1/${segs.join("/")}`;
}

// Bound recursion over an attacker-controlled JSON body so a deeply nested payload can't blow the stack or
// burn CPU before any handler runs. Real request bodies nest only a few levels; anything past this is hostile.
const MAX_DEPTH = 40;

// Bound the BREADTH too, which depth alone does not. Every distinct token found here costs two WebCrypto
// operations (an AES-CTR pass and an HMAC, see lib/idCodec.ts), and this runs at the outer edge - before auth.
// So a flat array of unique token-shaped strings was an unauthenticated way to buy a large multiple of the
// request's own size in crypto work. The largest real body is the bulk asset create, whose own schema caps it
// at 200 records, so anything past this is not a request the app has a route for; the surplus is simply left
// undecoded and fails downstream, exactly as a forged token does.
const MAX_REFS = 2000;

// Decode every `<collection>/<token>` ref string in a JSON body to `<collection>/<internal-id>`.
async function decodeBodyRefs<T>(body: T, codec: IdCodec): Promise<T> {
  const refs = new Set<string>();
  const collect = (n: unknown, depth: number) => {
    if (depth > MAX_DEPTH || refs.size >= MAX_REFS) return;
    if (typeof n === "string") {
      const m = BODY_REF_RE.exec(n);
      if (m && ENCODABLE.has(m[1]!)) refs.add(n);
    } else if (Array.isArray(n)) n.forEach((v) => collect(v, depth + 1));
    else if (n && typeof n === "object") Object.values(n).forEach((v) => collect(v, depth + 1));
  };
  collect(body, 0);
  if (refs.size === 0) return body;
  const map = new Map<string, string>();
  await Promise.all(
    [...refs].map(async (ref) => {
      const slash = ref.indexOf("/");
      const internal = await codec.decode(ref.slice(0, slash), ref.slice(slash + 1));
      if (internal) map.set(ref, `${ref.slice(0, slash)}/${internal}`);
    })
  );
  const rewrite = (n: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return n;
    if (typeof n === "string") return map.get(n) ?? n;
    if (Array.isArray(n)) return n.map((v) => rewrite(v, depth + 1));
    if (n && typeof n === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n)) o[k] = rewrite(v, depth + 1);
      return o;
    }
    return n;
  };
  return rewrite(body, 0) as T;
}

// Decode `<collection>/<token>` query-param values (e.g. ?employee=employees/<token>) -> internal id.
async function decodeSearchParams(url: URL, codec: IdCodec): Promise<boolean> {
  let changed = false;
  for (const [k, v] of [...url.searchParams.entries()]) {
    const m = BODY_REF_RE.exec(v);
    if (m && ENCODABLE.has(m[1]!)) {
      const internal = await codec.decode(m[1]!, m[2]!);
      if (internal) {
        url.searchParams.set(k, `${m[1]}/${internal}`);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Read a JSON body to text, refusing at the document cap instead of buffering past it.
 *
 * `request.text()` reads to the end of the stream, however long that is. For a body that DECLARES its length
 * the caller above skips the read entirely and leaves middleware/bodyLimit to refuse it - but a chunked body
 * declares nothing, so both the declared-length check there and the one above pass, and `text()` then
 * committed an unbounded payload to isolate memory. Here, at the outermost wrapper, that happens BEFORE auth:
 * an anonymous `Transfer-Encoding: chunked` POST with a JSON content type was a way to spend the isolate's
 * 128 MB against a 10 MiB cap without holding a credential.
 *
 * The capped read itself lives in services/documentsCommon beside the cap it enforces, because this was never
 * the only body read that needed it - the upload routes and the /diag relay read bytes the same way.
 */
async function readCapped(request: Request): Promise<string> {
  return new TextDecoder().decode(await requireCappedBody(request));
}

// Produce a request with the path token, query ref tokens, and JSON body ref tokens decoded to internal
// ids. Non-JSON bodies (binary uploads) are passed through untouched.
//
// THROWS `bodyTooLarge` for a JSON body that reads past the cap (see readCapped). This runs outside Hono, so
// the fetch handler in index.ts is what turns that into the problem+json response.
export async function decodeWireIdsRequest(request: Request, codec: IdCodec): Promise<Request> {
  const url = new URL(request.url);
  // THE API ONLY. `decodePathname` has always gated itself on `/v1/`, but the query and body rewrites below
  // did not - so every request the Worker serves had its JSON body read, parsed and RE-SERIALIZED here,
  // including the public ones mounted outside /v1. That is not a no-op on a body somebody else signed:
  // /esign/callback is authenticated by an HMAC over the RAW bytes (services/esign/cashfree.ts parseWebhook
  // verifies `HMAC(secret, timestamp + rawBody)`), and `JSON.stringify(JSON.parse(text))` is not the text.
  // Pretty-printed JSON, a trailing newline, `\uXXXX` escapes, `1.0` - each of them changes the bytes and
  // therefore the MAC, and the webhook answers "invalid webhook" for a delivery that was perfectly signed.
  // It fails CLOSED and SILENTLY (the vendor sees a 400; e-signatures then only land via the nightly
  // reconcile poll), and no test could see it, because the callback tests call the handler directly and
  // never come through this edge.
  //
  // Nothing outside /v1 wants the transform in the first place: wire tokens are an API convention, and the
  // public routes take their ids from a signed payload or their own HMAC'd token.
  if (!url.pathname.startsWith("/v1/") && url.pathname !== "/v1") return request;
  const newPath = await decodePathname(url.pathname, codec);
  const pathChanged = newPath !== url.pathname;
  if (pathChanged) url.pathname = newPath;
  const queryChanged = await decodeSearchParams(url, codec);

  // Decode refs in any JSON-family body: application/json AND structured-suffix types like
  // application/merge-patch+json (the Update content type). Without the `+json` arm, refs in a PATCH body
  // (e.g. department managers, ticket-category assignees) would reach services as raw wire tokens. The
  // predicate is shared with the authz body gate (http/jsonRequest.ts) so the two can never disagree about
  // whether a request carries a body.
  const isJson = isJsonBody(request.headers.get("content-type"));
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // An over-sized body is refused a few lines later by middleware/bodyLimit - but this edge runs FIRST (it is
  // the outermost wrapper in index.ts), so reading the body here is what actually committed it to isolate
  // memory, and the cap became a report rather than a limit. Declining to transform a body that is already
  // over the cap leaves it to be rejected on its declared length, untouched and unbuffered. Decoding it would
  // be wasted work on a request that cannot succeed.
  const declared = Number(request.headers.get("content-length"));
  const overCap = Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES;
  if (isJson && hasBody && !overCap) {
    const text = await readCapped(request);
    let outText = text;
    if (text) {
      try {
        outText = JSON.stringify(await decodeBodyRefs(JSON.parse(text), codec));
      } catch {
        outText = text; // not valid JSON - let the validator reject it
      }
    }
    // `content-length` IS DROPPED, because this request's body is not the one that header describes: a wire
    // token is 26 characters and the internal id it decodes to is 13, so every ref rewritten above shrinks the
    // payload. Carrying the original length forward leaves a header that contradicts the body it is attached
    // to - middleware/bodyLimit reads it (it only tests the over-cap case, so the mismatch is harmless there
    // today) and anything else that trusts it would be reading the pre-decode size. The runtime derives the
    // real length from the body it was handed.
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(url, { method: request.method, headers, body: outText });
  }
  if (!pathChanged && !queryChanged) return request;
  return new Request(url, request); // non-JSON: reuse method/headers/body (binary upload stays intact)
}
