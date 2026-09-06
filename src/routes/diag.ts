import { Hono } from "hono";
import type { AppEnv } from "../env";

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

/** The ingest origin and project id a DSN points at, or null if it is not a DSN we can parse. */
function parseDsn(dsn: string): { origin: string; projectId: string } | null {
  try {
    const u = new URL(dsn);
    // A DSN is https://<publicKey>@<host>/<projectId>; the project id is the whole path.
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.hostname || !/^\d+$/.test(projectId)) return null;
    return { origin: `https://${u.hostname}`, projectId };
  } catch {
    return null;
  }
}

export const diag = new Hono<AppEnv>();

diag.post("/", async (c) => {
  const configured = c.env.SENTRY_DSN && parseDsn(c.env.SENTRY_DSN);
  if (!configured) return c.notFound(); // relay not configured: indistinguishable from no such route

  // BYTES, not text. An envelope is only newline-delimited JSON at the top level: a session-replay item's
  // payload is zlib-compressed binary (the SDK compresses recordings in a Web Worker), and reading the body
  // with `c.req.text()` UTF-8-decodes it, turning every byte that is not valid UTF-8 into U+FFFD. Errors are
  // pure JSON and survive that; replays arrive corrupt and are dropped by the tracker, which looks exactly
  // like "replay is not working" with a perfectly healthy client holding a valid replay id.
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_ENVELOPE_BYTES) return c.text("payload too large", 413);

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
  // keep sending into a closed door. Everything else upstream returns is dropped.
  const headers = new Headers();
  for (const h of ["X-Sentry-Rate-Limits", "Retry-After"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(await upstream.text(), { status: upstream.status, headers });
});
