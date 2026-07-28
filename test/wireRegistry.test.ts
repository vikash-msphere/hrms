import { describe, it, expect } from "vitest";
import { RESOURCE_COLLECTIONS } from "../src/lib/authzResolve";
import { ENCODABLE } from "../src/middleware/encodeWireIds";
import { makeIdCodec, genId } from "../src/lib/idCodec";

// Guards the wire-id invariant: anything the app treats as an authz resource must be encoded on the
// wire, and every encodable collection must round-trip. A new resource that forgets to register in
// ENCODABLE (and would leak a raw internal id) fails here.
describe("wire-id registry completeness", () => {
  it("every authz resource collection is tokenized on the wire", () => {
    const missing = RESOURCE_COLLECTIONS.filter((c) => !ENCODABLE.has(c));
    expect(missing).toEqual([]);
  });

  it("encode/decode round-trips for every encodable collection", async () => {
    const codec = makeIdCodec(Buffer.alloc(32, 7).toString("base64"));
    const id = genId();
    for (const c of ENCODABLE) {
      const token = await codec.encode(c, id);
      expect(token).toHaveLength(26);
      expect(await codec.decode(c, token)).toEqual(id);
    }
  });

  it("a token does not cross-decode between any two distinct collections", async () => {
    const codec = makeIdCodec(Buffer.alloc(32, 7).toString("base64"));
    const id = genId();
    const cols = [...ENCODABLE];
    const token = await codec.encode(cols[0]!, id);
    for (const c of cols.slice(1)) expect(await codec.decode(c, token)).toBeNull();
  });
});
