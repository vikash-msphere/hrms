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
});
