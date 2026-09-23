import { describe, it, expect } from "vitest";
import { makeIdCodec, genId, bytesToBase32, base32ToBytes } from "../src/lib/idCodec";

const KEY = Buffer.alloc(32, 7).toString("base64");
const KEY2 = Buffer.alloc(32, 9).toString("base64");

describe("idCodec", () => {
  it("genId yields a 13-char base32 (8-byte) id", () => {
    const id = genId();
    expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{13}$/);
    expect(base32ToBytes(id, 8)).not.toBeNull();
  });

  it("round-trips id -> token -> id, token is 26 chars and opaque", async () => {
    const c = makeIdCodec(KEY);
    const id = genId();
    const token = await c.encode("employees", id);
    expect(token).toHaveLength(26);
    expect(token).not.toContain(id); // opaque - the internal id is not visible
    expect(await c.decode("employees", id === token ? "x" : token)).toEqual(id);
  });

  it("is deterministic (stable wire token for a given id+collection)", async () => {
    const c = makeIdCodec(KEY);
    const id = genId();
    expect(await c.encode("employees", id)).toEqual(await c.encode("employees", id));
  });

  it("is collection-bound: a token does not decode under another collection", async () => {
    const c = makeIdCodec(KEY);
    const id = genId();
    const token = await c.encode("employees", id);
    expect(await c.decode("departments", token)).toBeNull();
    expect(await c.decode("employees", token)).toEqual(id);
  });

  it("rejects a tampered token", async () => {
    const c = makeIdCodec(KEY);
    const token = await c.encode("employees", genId());
    const flip = (token[0] === "0" ? "1" : "0") + token.slice(1);
    expect(await c.decode("employees", flip)).toBeNull();
  });

  it("rejects a token minted with a different key", async () => {
    const a = makeIdCodec(KEY);
    const b = makeIdCodec(KEY2);
    const token = await a.encode("employees", genId());
    expect(await b.decode("employees", token)).toBeNull();
  });

  it("rejects malformed tokens (length / illegal char)", async () => {
    const c = makeIdCodec(KEY);
    expect(await c.decode("employees", "tooshort")).toBeNull();
    expect(await c.decode("employees", "!".repeat(26))).toBeNull();
  });

  it("distinct ids produce distinct tokens", async () => {
    const c = makeIdCodec(KEY);
    const t1 = await c.encode("employees", genId());
    const t2 = await c.encode("employees", genId());
    expect(t1).not.toEqual(t2);
  });

  it("base32 byte codec round-trips arbitrary 8/16-byte buffers", () => {
    for (const len of [8, 16]) {
      const buf = crypto.getRandomValues(new Uint8Array(len));
      const round = base32ToBytes(bytesToBase32(buf), len);
      expect(round).not.toBeNull();
      expect([...round!]).toEqual([...buf]);
    }
  });
});
