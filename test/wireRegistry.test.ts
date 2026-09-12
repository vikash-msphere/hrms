/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { RESOURCE_COLLECTIONS } from "../src/lib/authzResolve";
import { ENCODABLE } from "../src/middleware/encodeWireIds";
import { makeIdCodec, genId } from "../src/lib/idCodec";
import serializeSrc from "../src/http/serialize.ts?raw";
import reviewsSrc from "../src/services/reviews.ts?raw";

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

  // THE CHECK ABOVE IS NOT THE WHOLE CHECK, which is how `access-rules` and `activity` came to publish raw
  // internal ids for as long as they did. It reads `RESOURCE_COLLECTIONS`, i.e. the keys of the authz
  // resolver's TABLES map - so it only ever asks about collections that ARE in that map, and a wire resource
  // outside it (the ACL management surface; the audit trail) was never asked about at all. Both serialized
  // `path: <collection>/${row.uuid}` off a `pk()` the entire time.
  //
  // So the second half asks the question the other way round: not "is every known resource registered" but
  // "does anything BUILD a wire path out of a uuid without being registered". The serializers are read as
  // source, because the answer has to come from the code that actually emits the string rather than from a
  // list someone maintains alongside it - a list is the thing that drifted.
  it("every wire path built from a row uuid belongs to a tokenized collection", () => {
    const PATH_FROM_UUID = /path:\s*`([a-z][a-z0-9-]*)\/\$\{[^}]*\buuid\b[^}]*\}/g;
    const found = new Set<string>();
    for (const src of [serializeSrc, reviewsSrc]) {
      for (const m of src.matchAll(PATH_FROM_UUID)) found.add(m[1]!);
    }
    // Sanity: the scan has to be finding something, or it would pass by matching nothing at all.
    expect(found.size).toBeGreaterThan(5);
    expect([...found].filter((c) => !ENCODABLE.has(c)).sort()).toEqual([]);
  });

  it("a token does not cross-decode between any two distinct collections", async () => {
    const codec = makeIdCodec(Buffer.alloc(32, 7).toString("base64"));
    const id = genId();
    const cols = [...ENCODABLE];
    const token = await codec.encode(cols[0]!, id);
    for (const c of cols.slice(1)) expect(await codec.decode(c, token)).toBeNull();
  });
});
