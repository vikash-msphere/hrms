/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../src/env";
import { forbidden } from "../src/lib/errors";
import { errorHandler } from "../src/middleware/errorHandler";

// What a thrown error becomes on the wire (middleware/errorHandler.ts).
//
// The case that brought this file into being is the FRAMEWORK'S own client error. Hono throws an
// `HTTPException` for the failures it handles before a route sees them, and one of those sits on every
// validated write in the app: `zValidator` refuses a body that will not parse with a 400. It matched none of
// the handler's branches, so it fell to the catch-all and a caller with a trailing comma in their JSON was
// told the SERVER had crashed - and, because the log line is gated on `status >= 500`, every one of those
// raised an `unhandled error` alert with a stack for a fault that did not exist.

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.post("/validated", zValidator("json", z.object({ name: z.string() })), (c) => c.json({ ok: true }));
app.get("/denied", () => {
  throw forbidden("nope");
});
// A 4xx the app has no word of its own for, and a 5xx, which must NOT be laundered into a client error.
app.get("/teapot", () => {
  throw new HTTPException(418, { message: "short and stout" });
});
app.get("/framework-crash", () => {
  throw new HTTPException(503, { message: "upstream gone" });
});

const post = (path: string, body: string) =>
  app.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });

describe("errorHandler: a client's mistake is not a 500", () => {
  it("answers 400 problem+json for a body that will not parse", async () => {
    const res = await post("/validated", "{ not json");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    const body = (await res.json()) as { type?: string; title?: string; status?: number; detail?: string };
    // The SAME vocabulary as an invalidArgument raised anywhere else, so nothing has to learn a second one.
    expect(body.type).toBe("/errors/invalid-argument");
    expect(body.status).toBe(400);
    // Hono's own fixed string. It names what is wrong without echoing any of the request back, which is the
    // rule the Zod branch follows for the same reason.
    expect(body.detail).toContain("Malformed JSON");
  });

  it("lets a well-formed body through to the route", async () => {
    // The half that proves the case above is about the PARSE and not about the route being broken.
    const ok = await post("/validated", JSON.stringify({ name: "x" }));
    expect(ok.status).toBe(200);
  });

  it("keeps the status of a 4xx the app has no word of its own for", async () => {
    // Flattening every unmapped client error into a 400 would misreport the reason; the status is the part a
    // client actually acts on.
    const res = await app.request("/teapot");
    expect(res.status).toBe(418);
    expect(((await res.json()) as { status?: number }).status).toBe(418);
  });

  it("does not launder a framework 5xx into a client error", async () => {
    // A 5xx HTTPException IS a server fault. It keeps the generic internal body (nothing about our internals
    // travels) and stays on the side of the line that gets logged.
    const res = await app.request("/framework-crash");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { type?: string; detail?: string };
    expect(body.type).toBe("/errors/internal");
    expect(body.detail).toBeUndefined();
  });

  it("leaves the app's own errors exactly as they were", async () => {
    const res = await app.request("/denied");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { type?: string; detail?: string };
    expect(body.type).toBe("/errors/permission-denied");
    expect(body.detail).toBe("nope");
  });
});

// ---- `instance` never carries an internal id ---------------------------------------------------------------
//
// The path an error handler sees is the DECODED one: `decodeWireIdsRequest` runs outside Hono (src/index.ts),
// so by the time anything throws, `c.req.path` reads `/v1/employees/<13-char internal id>` - the primary key
// lib/idCodec.ts exists to keep off the wire. And a problem body is the one response shape the outbound edge
// never rewrites: `encodeWireIdsMiddleware` only touches `application/json`, problem details are
// `application/problem+json`, and a throw unwinds past its post-`next()` block regardless. So every 403, 404,
// 409 and validation 400 on an item path published that id verbatim.
//
// Asserted on the handler rather than end to end, because that is where the masking lives and where the next
// branch will be added - the four problem shapes below are the four the handler builds.
const ID = "0abc1def2ghj3"; // 13 Crockford-base32 chars: exactly what lib/idCodec.ts#genId emits

const leaky = new Hono<AppEnv>();
leaky.onError(errorHandler);
leaky.get(`/v1/employees/:id/bank-account`, () => {
  throw forbidden("nope");
});
// A ZodError THROWN, which is how a custom method's body fails (http/collectionRoute.ts calls
// `own.schema.parse(...)` directly); `zValidator` answers its own 400 and never reaches the handler.
leaky.post(`/v1/employees/:id`, async (c) => c.json(z.object({ name: z.string() }).parse(await c.req.json())));
leaky.get(`/v1/employees/:id:verb`, () => {
  throw new HTTPException(418, { message: "short and stout" });
});

const instanceOf = async (res: Response) => ((await res.json()) as { instance?: string }).instance;

describe("errorHandler: the internal id never reaches problem.instance", () => {
  it("masks the id segment on an app error", async () => {
    const res = await leaky.request(`/v1/employees/${ID}/bank-account`);
    expect(res.status).toBe(403);
    const instance = await instanceOf(res);
    expect(instance).not.toContain(ID);
    expect(instance).toBe("/v1/employees/_/bank-account");
  });

  it("masks it on a validation failure too", async () => {
    const res = await leaky.request(`/v1/employees/${ID}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await instanceOf(res)).toBe("/v1/employees/_");
  });

  it("masks it on a framework 4xx, keeping the verb that was refused", async () => {
    // The verb names WHAT was refused and carries no id, so it survives - only the id half is masked.
    const res = await leaky.request(`/v1/employees/${ID}:verb`);
    expect(res.status).toBe(418);
    expect(await instanceOf(res)).toBe("/v1/employees/_:verb");
  });

  it("leaves a path that carries no internal id untouched", async () => {
    // A wire token is 26 chars and a settings key is a word: neither is an id, and masking either would make
    // `instance` useless for the paths where it is the whole diagnostic.
    const res = await leaky.request("/v1/employees/0abc1def2ghj30abc1def2ghj3/bank-account");
    expect(res.status).toBe(403);
    expect(await instanceOf(res)).toBe("/v1/employees/0abc1def2ghj30abc1def2ghj3/bank-account");
  });
});
