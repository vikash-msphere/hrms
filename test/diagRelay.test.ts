/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../src/env";
import { diag } from "../src/routes/diag";

// The telemetry relay is the app's only unauthenticated WRITE-shaped surface: no session, no CSRF header, and
// it makes an outbound request on the caller's say-so. That combination is an open relay unless every one of
// its refusals holds, so the refusals are what this file tests - not the happy path, which is one `fetch`.
//
// The attack it exists to prevent: anyone POSTs an envelope naming THEIR dsn, and the Worker cheerfully
// forwards traffic to a third party (or burns this org's event quota) with our egress and our IP.
const DSN = "https://abc123@o4511976927461376.ingest.de.sentry.io/4511982864498768";
const INGEST = "https://o4511976927461376.ingest.de.sentry.io/api/4511982864498768/envelope/";

const app = new Hono<AppEnv>();
app.route("/diag", diag);

/** An envelope whose header line addresses `dsn`, which is the only thing that decides where bytes go. */
const envelope = (dsn?: string) =>
  `${JSON.stringify(dsn ? { dsn, sent_at: "2026-01-01T00:00:00Z" } : { sent_at: "2026-01-01T00:00:00Z" })}\n` +
  `{"type":"event"}\n{"message":"hi"}\n`;

const post = (body: string, env: Record<string, unknown> = { SENTRY_DSN: DSN }) =>
  app.request("/diag", { method: "POST", body }, env);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("diagnostics relay", () => {
  it("forwards an envelope addressed to the configured project, verbatim", async () => {
    const body = envelope(DSN);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The destination is built from OUR configured DSN, never from the request.
    expect(url).toBe(INGEST);
    // Verbatim: the envelope carries the SDK's own auth in its header line, so re-encoding it would only
    // create ways to corrupt it. Compared as bytes because that is what the relay forwards - see the binary
    // replay case below for why it must not be a string.
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(body);
  });

  it("forwards a binary replay payload byte for byte", async () => {
    // The regression this exists for. A session-replay item's payload is zlib-compressed binary, so the
    // envelope is NOT text: reading it with `req.text()` UTF-8-decodes it and replaces every invalid byte
    // with U+FFFD. Error envelopes are pure JSON and survive that unharmed, which is what made the bug look
    // like "replays don't work" while errors kept arriving - and why this asserts on bytes, not on a string.
    const head = new TextEncoder().encode(
      `${JSON.stringify({ dsn: DSN })}\n${JSON.stringify({ type: "replay_recording", length: 8 })}\n`,
    );
    // 0x78 0x9c is a zlib header; 0xff 0xfe and the lone 0x80 are sequences no UTF-8 decoder can round-trip.
    const compressed = new Uint8Array([0x78, 0x9c, 0xff, 0xfe, 0x80, 0x00, 0x1f, 0x8b]);
    const raw = new Uint8Array(head.length + compressed.length);
    raw.set(head, 0);
    raw.set(compressed, head.length);

    const res = await app.request("/diag", { method: "POST", body: raw }, { SENTRY_DSN: DSN });
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body as Uint8Array).toEqual(raw);
  });

  it("refuses an envelope addressed at another project on the same host", async () => {
    const res = await post(envelope("https://abc123@o4511976927461376.ingest.de.sentry.io/9999999"));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the right project id under a different host", async () => {
    // The open-relay case wearing the right number: matching on project id alone would forward this.
    const res = await post(envelope("https://abc123@evil.example.com/4511982864498768"));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an envelope that addresses nothing at all", async () => {
    const res = await post(envelope(undefined));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an envelope", async () => {
    expect((await post("not json\n{}")).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the body, so this cannot be used as an upload endpoint", async () => {
    const res = await post(envelope(DSN) + "x".repeat(1_000_001));
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps a CHUNKED body as it reads, rather than buffering it and measuring after", async () => {
    // The case the declared-length checks cannot answer: `Transfer-Encoding: chunked` sends no
    // `Content-Length`, so middleware/bodyLimit has nothing to refuse, and the inbound wire-id edge caps only
    // JSON content types - which an envelope is not. This route takes no credential, so an unbounded read
    // here was the cheapest way to spend a 128 MB isolate (shared with every unrelated in-flight request)
    // against a 1 MB ceiling. `readCappedBody` abandons the read instead, so the bytes held are bounded by
    // one chunk past the cap however long the stream claims to be.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(256 * 1024)); // never closes: an endless body
      },
    });
    const res = await app.request(
      "/diag",
      { method: "POST", body: stream, duplex: "half" } as RequestInit,
      { SENTRY_DSN: DSN },
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    // Five 256 KiB chunks reach 1.25 MB, so it stops within a chunk of the cap - not at the end of a stream
    // that has no end.
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it("is not there at all when no destination is configured", async () => {
    const res = await post(envelope(DSN), {});
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes back only the rate-limit headers the SDK needs to honour", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", {
        status: 429,
        headers: {
          "X-Sentry-Rate-Limits": "60::organization",
          "Retry-After": "60",
          // Anything else upstream says is upstream's business, not the browser's.
          "Set-Cookie": "sentrysid=abc",
          "X-Upstream-Detail": "leaky",
        },
      }),
    );
    const res = await post(envelope(DSN));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-Sentry-Rate-Limits")).toBe("60::organization");
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("X-Upstream-Detail")).toBeNull();
  });

  it("passes back no upstream BODY either", async () => {
    // The relay is unauthenticated, so what it hands the browser is what anyone can make it hand them. The
    // SDK's transport reads the status and the two rate-limit headers above; the tracker's own JSON was being
    // forwarded on top of that for no caller, which is a third party's words served from our origin.
    fetchMock.mockResolvedValueOnce(new Response('{"id":"deadbeef","detail":"upstream said this"}', { status: 200 }));
    const res = await post(envelope(DSN));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("forwards no client IP", async () => {
    await app.request(
      "/diag",
      { method: "POST", body: envelope(DSN), headers: { "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "203.0.113.7" } },
      { SENTRY_DSN: DSN },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    // The relayed request presents the Worker, not the employee. Sending the address on would be choosing to
    // hand staff IPs to a third party - and an error report never needed one.
    expect(headers.get("X-Forwarded-For")).toBeNull();
    expect(headers.get("CF-Connecting-IP")).toBeNull();
  });
});
