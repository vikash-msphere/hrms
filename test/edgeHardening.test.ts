import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { customMethod } from "../src/http/customMethod";
import { requestId } from "../src/middleware/requestId";
import { AppError } from "../src/lib/errors";

// Small edges from the pre-production review: a malformed path escape is the caller's 400, not our 500, and an
// upstream request id is honoured only when it looks like one.

describe("customMethod", () => {
  const app = new Hono();
  app.onError((e, c) => c.json({ status: e instanceof AppError ? e.httpStatus : 500 }, e instanceof AppError ? (e.httpStatus as 400) : 500));
  app.post("/v1/things/:id", (c) => c.json(customMethod(c)));

  it("splits an id and a verb", async () => {
    const res = await app.request("/v1/things/abc%2Fd:approve", { method: "POST" });
    expect(await res.json()).toEqual({ id: "abc/d", verb: "approve" });
  });

  it("answers a malformed percent-escape with a 400", async () => {
    const res = await app.request("/v1/things/x%E0%A4:approve", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("requestId", () => {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", requestId as never);
  app.get("/", (c) => c.text(c.get("requestId")));

  it("keeps a well-formed upstream id", async () => {
    const res = await app.request("/", { headers: { "x-request-id": "edge-7f3a.01" } });
    expect(await res.text()).toBe("edge-7f3a.01");
  });

  it("replaces one that is too long or carries anything else", async () => {
    // (A CR/LF value never gets this far - `Headers` itself refuses to carry one - so it is not a case here.)
    for (const bad of ["x".repeat(65), "a b", "id forged: yes", "<script>", "é"]) {
      const res = await app.request("/", { headers: { "x-request-id": bad } });
      const id = await res.text();
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
