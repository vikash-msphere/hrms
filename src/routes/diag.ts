import { Hono } from "hono";
import type { AppEnv } from "../env";
import { readCappedBody } from "../services/documentsCommon";
import { counter } from "../lib/isolateRate";

// Diagnostics relay: the browser posts its telemetry envelope here and the Worker forwards it to the error
// tracker, server to server.
//
// WHY THIS EXISTS. The SPA used to POST straight to the vendor's ingest host. Ad and tracking blockers - uBlock,
// AdGuard, Brave shields, corporate DNS/MITM filters - carry that host on every default list, and a blocked
// request comes back with no CORS headers, so the browser reports it as "CORS Failed" and the SDK drops the
// event. Silently: nobody finds out that a chunk of users report nothing. Relaying through our own origin puts
// nothing on a blocklist in the page's traffic.
//
// WHY THE PATH IS `/diag` AND NOT SOMETHING DESCRIPTIVE. Blockers match paths as readily as hosts, and the
// vendor's own documented path (`/sentry-tunnel`) is already a filter rule. A generic name is not obscurity for
// its own sake - it is the difference between the relay working and being blocked with it.
//
// OUTSIDE /v1, like /found and /esign: the SDK cannot send a session cookie, a CSRF header, or anything else
// the API middleware requires, and telemetry from a signed-out or half-broken page is exactly the telemetry
// worth having. That makes this an unauthenticated public endpoint, so it is written as one:
//
//   - It forwards to ONE project. The destination is not taken from the request - the envelope's own `dsn`
//     is checked against the configured DSN and anything else is refused. Without that this is an open relay
//     that anyone can burn the org's event quota through, or use to bounce traffic at a third party.
//   - It caps the body. Replay envelopes are the large ones and they are still small; a ceiling here stops
//     this becoming a general-purpose upload endpoint.
//   - It forwards no client IP. A relayed request presents the Worker's address, so the tracker records that
//     rather than the employee's. Deliberate: the address was never the point of an error report, and adding
//     `X-Forwarded-For` to "fix" it would be choosing to send staff IPs to a third party.
//   - It answers with the tracker's status and nothing else. No response header, body or timing from upstream
//     is echoed back beyond what the SDK needs to honour rate limits.
//
// Disabled unless SENTRY_DSN is configured on the Worker: no destination, no relay, 404.

// Generous for an error envelope, tiny for an upload. A session replay segment - the largest thing the SDK
// sends - runs well under this.
const MAX_ENVELOPE_BYTES = 1_000_000;

// A FLOOR, not the rate limit - see lib/isolateRate.ts for what that distinction is and why the floor exists
// anyway. This is the sharpest of the unauthenticated routes: every POST forwards up to a megabyte to the
// tracker as a real outbound request, and the DSN it is checked against is baked into the public bundle, so
// burning the org's event quota needs no credential at all. It never rejects a real client: the SDK's own
// transport sends far below this, and a rejection returns 429 with Retry-After, which is what it backs off on.
const relay = counter(600);

/** The ingest origin and project id a DSN points at, or null if it is not a DSN we can parse. */
function parseDsn(dsn: string): { origin: string; projectId: string } | null {
  try {
    const u = new URL(dsn);
    // A DSN is https://<publicKey>@<host>[:<port>]/<projectId>; the project id is the whole path.
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.hostname || !/^\d+$/.test(projectId)) return null;
    // The PORT is part of the destination. It is absent from every hosted DSN, which is why dropping it was
    // invisible - but a self-hosted tracker on a non-443 port parsed to a portless origin, so the envelope was
    // forwarded to :443 of the right host and the relay failed for a configuration that is otherwise valid.
    // Both the configured DSN and the sent one go through here, so the equality check below stayed consistent
    // either way; only the outbound URL was wrong.
    //
    // The SCHEME stays pinned to https rather than taken from the DSN: this is a server-to-server relay of
    // telemetry the app collected, and a DSN edited to `http://` would silently downgrade it to plaintext.
    return { origin: `https://${u.host}`, projectId };
  } catch {
    return null;
  }
}

export const diag = new Hono<AppEnv>();

diag.post("/", async (c) => {
  const configured = c.env.SENTRY_DSN && parseDsn(c.env.SENTRY_DSN);
  if (!configured) return c.notFound(); // relay not configured: indistinguishable from no such route

  // Counted BEFORE the body is read, so a throttled request costs neither the buffer nor the outbound call.
  if (relay.throttled(Date.now())) {
    return c.text("too many reports", 429, { "Retry-After": String(relay.retryAfterSeconds) });
  }

  // BYTES, not text. An envelope is only newline-delimited JSON at the top level: a session-replay item's
  // payload is zlib-compressed binary (the SDK compresses recordings in a Web Worker), and reading the body
  // with `c.req.text()` UTF-8-decodes it, turning every byte that is not valid UTF-8 into U+FFFD. Errors are
  // pure JSON and survive that; replays arrive corrupt and are dropped by the tracker, which looks exactly
  // like "replay is not working" with a perfectly healthy client holding a valid replay id.
  //
  // CAPPED AS IT IS READ, not measured afterwards. `c.req.arrayBuffer()` reads to the end of the stream, so
  // the size check below it fired after the payload was already in isolate memory - and nothing upstream
  // stopped it: middleware/bodyLimit decides from `Content-Length`, which a `Transfer-Encoding: chunked`
  // request does not send, and the inbound wire-id edge only caps JSON content types, which an envelope is
  // not. This is the one route in the app that needs no credential, so it was the cheapest way to spend a
  // 128 MB isolate - shared by every unrelated request the isolate was serving - against a 1 MB ceiling. The
  // rate floor above bounds how OFTEN, not how big; one request was enough.
  const raw = await readCappedBody(c.req.raw, MAX_ENVELOPE_BYTES);
  if (!raw) return c.text("payload too large", 413);
  const body = new Uint8Array(raw);

  // An envelope's FIRST line is a JSON header carrying the DSN the SDK was configured with, and that is the
  // only thing here that decides where the bytes go. Only this line is decoded; the rest is never inspected.
  const nl = body.indexOf(0x0a);
  let sent: { dsn?: string };
  try {
    if (nl <= 0) throw new Error("no header line");
    sent = JSON.parse(new TextDecoder().decode(body.subarray(0, nl)));
  } catch {
    return c.text("malformed envelope", 400);
  }
  const from = sent.dsn ? parseDsn(sent.dsn) : null;
  // Both halves, not just the project id: a matching id under a different host would relay to somebody else's
  // ingest, which is the open-relay case wearing the right number.
  if (!from || from.origin !== configured.origin || from.projectId !== configured.projectId) {
    return c.text("unknown destination", 403);
  }

  // The one call here that reaches outside, and the one that can fail for reasons that are nobody's fault: the
  // tracker is down, or the Worker's outbound connection dies mid-flight ("Network connection lost"). An
  // unhandled rejection makes THAT a 500 out of the error relay - the page's error reporter erroring, which
  // the SDK reports, which comes back here. A gateway status says what happened and stops the loop; the SDK
  // backs off and keeps the envelope.
  let upstream: Response;
  try {
    upstream = await fetch(`${configured.origin}/api/${configured.projectId}/envelope/`, {
      method: "POST",
      // Byte-for-byte what arrived. Its header line already carries the DSN and the SDK's auth, which is why no
      // key of ours is involved and nothing here needs a secret - and why re-encoding it could only corrupt it.
      body,
      headers: { "Content-Type": "application/x-sentry-envelope" },
    });
  } catch {
    return c.text("tracker unreachable", 502);
  }

  // Rate-limit headers are the one thing the SDK reads back: without them it cannot honour a 429 and will
  // keep sending into a closed door. Everything else upstream returns is dropped - including the BODY, which
  // this used to pass straight through while the header above claimed it did not. The SDK's transport reads
  // the status and those two headers and nothing else, so relaying the tracker's own JSON bought nothing and
  // made an unauthenticated endpoint a window onto whatever a third party chose to answer with. The stream is
  // cancelled rather than read, so dropping it costs less than forwarding it did.
  const headers = new Headers();
  for (const h of ["X-Sentry-Rate-Limits", "Retry-After"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  await upstream.body?.cancel();
  return new Response(null, { status: upstream.status, headers });
});
