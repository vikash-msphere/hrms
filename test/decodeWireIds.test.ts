import { describe, it, expect } from "vitest";
import { makeIdCodec } from "../src/lib/idCodec";
import { decodeWireIdsRequest } from "../src/middleware/decodeWireIds";

const codec = makeIdCodec(Buffer.alloc(32, 7).toString("base64"));
const EVE = "2cn3wk30dszr6";
const DEPT = "20n3pk2xdszr0";
const req = (url: string, init?: RequestInit) => new Request(`http://x${url}`, init);
const path = (r: Request) => new URL(r.url).pathname;

describe("decodeWireIdsRequest", () => {
  it("decodes the path token -> internal id", async () => {
    const token = await codec.encode("employees", EVE);
    const out = await decodeWireIdsRequest(req(`/v1/employees/${token}`), codec);
    expect(path(out)).toEqual(`/v1/employees/${EVE}`);
  });

  it("preserves a trailing :verb and sub-resource segments", async () => {
    const token = await codec.encode("employees", EVE);
    expect(path(await decodeWireIdsRequest(req(`/v1/employees/${token}:getPhoto`), codec))).toEqual(`/v1/employees/${EVE}:getPhoto`);
    expect(path(await decodeWireIdsRequest(req(`/v1/employees/${token}/bank-account`), codec))).toEqual(`/v1/employees/${EVE}/bank-account`);
  });

  it("leaves me / - / list paths untouched", async () => {
    expect(path(await decodeWireIdsRequest(req(`/v1/employees/me`), codec))).toEqual(`/v1/employees/me`);
    expect(path(await decodeWireIdsRequest(req(`/v1/employees`), codec))).toEqual(`/v1/employees`);
  });

  it("leaves a forged token as-is (so it 404s downstream, not cross-resolves)", async () => {
    const forged = "z".repeat(26);
    expect(path(await decodeWireIdsRequest(req(`/v1/employees/${forged}`), codec))).toEqual(`/v1/employees/${forged}`);
  });

  it("decodes a <collection>/<token> query param (e.g. ?employee=) -> internal id", async () => {
    const token = await codec.encode("employees", EVE);
    const out = await decodeWireIdsRequest(req(`/v1/leave-balances?employee=employees/${token}`), codec);
    expect(new URL(out.url).searchParams.get("employee")).toEqual(`employees/${EVE}`);
  });

  it("decodes every value of a repeated query param, in order, beside the params around it", async () => {
    const eve = await codec.encode("employees", EVE);
    const other = DEPT; // any real id will do; only its being a second, different employee ref matters
    const second = await codec.encode("employees", other);
    const out = await decodeWireIdsRequest(req(`/v1/search?q=laptop&notowner=employees/${eve}&in=tickets&notowner=employees/${second}`), codec);
    const q = new URL(out.url).searchParams;
    expect(q.getAll("notowner")).toEqual([`employees/${EVE}`, `employees/${other}`]);
    expect([...q.keys()]).toEqual(["q", "notowner", "in", "notowner"]);
    expect(q.get("q")).toEqual("laptop");
  });

  it("leaves non-ref query params untouched", async () => {
    const out = await decodeWireIdsRequest(req(`/v1/employees?show_deleted=true&max_page_size=20`), codec);
    const q = new URL(out.url).searchParams;
    expect(q.get("show_deleted")).toEqual("true");
    expect(q.get("max_page_size")).toEqual("20");
  });

  it("decodes body ref tokens -> internal ids; leaves plain fields", async () => {
    const body = { department: `departments/${await codec.encode("departments", DEPT)}`, first_name: "Eve" };
    const out = await decodeWireIdsRequest(
      req(`/v1/employees`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      codec
    );
    expect(await out.json()).toEqual({ department: `departments/${DEPT}`, first_name: "Eve" });
  });

  it("decodes body refs in a merge-patch+json body (the Update content type)", async () => {
    const body = { value: { categories: [{ key: "hr", assignee: `employees/${await codec.encode("employees", EVE)}` }] } };
    const out = await decodeWireIdsRequest(
      req(`/v1/settings/ticket-categories`, { method: "PATCH", headers: { "content-type": "application/merge-patch+json" }, body: JSON.stringify(body) }),
      codec
    );
    expect(await out.json()).toEqual({ value: { categories: [{ key: "hr", assignee: `employees/${EVE}` }] } });
  });

  it("passes non-JSON bodies through (binary upload path still rewritten)", async () => {
    const token = await codec.encode("employees", EVE);
    const out = await decodeWireIdsRequest(
      req(`/v1/employees/${token}:uploadPhoto`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3]) }),
      codec
    );
    expect(path(out)).toEqual(`/v1/employees/${EVE}:uploadPhoto`);
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  // A body that declares no length is the case both length checks miss: this edge's own skip (which reads
  // `content-length`) and middleware/bodyLimit's. It runs BEFORE auth, so reading such a body to the end was
  // an anonymous way to spend the isolate's memory against a 10 MiB cap. A stream is used rather than a big
  // string because that is the only shape that declares nothing - a string body sets content-length.
  const streamOf = (chunkBytes: number, chunks: number): ReadableStream<Uint8Array> => {
    let sent = 0;
    return new ReadableStream({
      pull(c) {
        if (sent++ >= chunks) return c.close();
        c.enqueue(new Uint8Array(chunkBytes));
      },
    });
  };
  const chunked = (body: ReadableStream<Uint8Array>) =>
    new Request("http://x/v1/employees", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);

  it("refuses a chunked JSON body that reads past the cap, instead of buffering it", async () => {
    // 12 MiB in 1 MiB chunks, against the 10 MiB document cap.
    await expect(decodeWireIdsRequest(chunked(streamOf(1024 * 1024, 12)), codec)).rejects.toMatchObject({
      httpStatus: 400,
      type: "/errors/invalid-argument",
    });
  });

  it("still decodes a chunked JSON body that stays under the cap", async () => {
    const token = await codec.encode("departments", DEPT);
    const bytes = new TextEncoder().encode(JSON.stringify({ department: `departments/${token}` }));
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    const out = await decodeWireIdsRequest(chunked(stream), codec);
    expect(await out.json()).toEqual({ department: `departments/${DEPT}` });
  });
});

// The edge is the API's, and only the API's. Everything mounted outside /v1 is either authenticated by bytes
// somebody else signed or carries its own token, and both are broken by touching the request.
describe("decodeWireIdsRequest leaves non-/v1 requests alone", () => {
  it("hands back the SAME request, with the body byte-identical", async () => {
    // The e-sign webhook's MAC covers exactly these bytes: `HMAC(secret, timestamp + rawBody)`, verified in
    // services/esign/cashfree.ts. This edge used to read the body and pass on
    // `JSON.stringify(JSON.parse(text))`, which is a DIFFERENT string for the same JSON - the indentation and
    // the trailing newline below are enough - so every correctly-signed delivery verified against bytes the
    // provider never sent and was answered "invalid webhook". Pretty-printed deliberately: compact JSON is
    // what happens to survive a round trip, which is why the suite could not see this.
    const token = await codec.encode("employees", EVE);
    const raw = `{\n  "data": {\n    "reference_id": 42,\n    "note": "employees/${token}"\n  }\n}\n`;
    const r = req("/esign/callback/cashfree", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    const out = await decodeWireIdsRequest(r, codec);
    expect(out).toBe(r); // not re-created, so not re-serialized
    expect(await out.text()).toBe(raw); // and the ref is NOT decoded: outside /v1 there are no wire ids
  });

  it("leaves a non-/v1 query string untouched", async () => {
    // /auth/callback carries Google's `state` and `code`. Nothing there is a wire ref, and rewriting a value
    // that merely looked like one would corrupt the round trip.
    const token = await codec.encode("employees", EVE);
    const out = await decodeWireIdsRequest(req(`/auth/callback?state=employees/${token}&code=x`), codec);
    expect(new URL(out.url).search).toEqual(`?state=employees/${token}&code=x`);
  });

  it("still transforms /v1 itself (the guard is a prefix, not a rewrite of the rule)", async () => {
    const token = await codec.encode("employees", EVE);
    expect(path(await decodeWireIdsRequest(req(`/v1/employees/${token}`), codec))).toEqual(`/v1/employees/${EVE}`);
  });
});
