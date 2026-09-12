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

  // AND A THIRD ANGLE, because the two above both look at `path`.
  //
  // `path` is not the only place a primary key leaves. Every REFERENCE to another record leaves too, and the
  // outbound edge only rewrites the `<collection>/<id>` shape - so a field emitted as a bare column value is
  // published exactly as stored, matching nothing the codec looks for. Eight were: `locked_by` (on every
  // lockable collection, via `baseResource`), `decided_by` on the four request collections, `responded_by`,
  // and payroll's `submitted_by`/`approved_by`. All eight hold a `users` primary key - the value the codec
  // exists to keep off the wire - on the rows recording who approved money and who unlocked a record.
  //
  // The scan is for the SHAPE that produces one: an emitted field assigned a column whose name ends in `Id`
  // or `By`, not wrapped in `ref(`. Each survivor has to be named here with the reason it is not a record id,
  // which is the decision the eight above were never asked to make.
  it("emits no reference as a bare column value", () => {
    // Fields that end in `Id`/`By` and are NOT a reference to a record, so `ref()` would be wrong for them.
    const NOT_A_RECORD_REF: Record<string, string> = {
      correlation_id: "an act id (lib/audit.ts), not a row - groups entries written by one request",
      session_id: "an fnv1a64 hash of uuid+iat (middleware/auth.ts), deliberately not the session itself",
      batch_id: "groups the rows of one company/department bonus award; names no record",
      tax_id: "the employee's tax identifier (PAN), a government number typed by a person",
    };
    // `field: r.someId,` / `field: r.someBy,` - the bare form. A `ref(...)`, a ternary or anything else on the
    // right-hand side does not match, which is the point: those are the shapes that reach the codec.
    const BARE = /^\s+([a-z_0-9]+):\s*r\.[a-zA-Z]*(?:Id|By)\b\s*(?:\?\?\s*undefined\s*)?,\s*$/gm;
    const bare = [...serializeSrc.matchAll(BARE)].map((m) => m[1]!);
    // Sanity: the allow-listed ones must still be found, or the pattern has stopped matching and this passes
    // by scanning nothing.
    expect(bare.length).toBeGreaterThan(0);
    const leaked = [...new Set(bare.filter((f) => !(f in NOT_A_RECORD_REF)))].sort();
    expect(
      leaked,
      "emitted as a bare id: the outbound edge only rewrites `<collection>/<id>`, so this publishes the " +
        "internal primary key - wrap it in ref(<collection>, ...), or name it in NOT_A_RECORD_REF with why it is not one",
    ).toEqual([]);
  });

  it("a token does not cross-decode between any two distinct collections", async () => {
    const codec = makeIdCodec(Buffer.alloc(32, 7).toString("base64"));
    const id = genId();
    const cols = [...ENCODABLE];
    const token = await codec.encode(cols[0]!, id);
    for (const c of cols.slice(1)) expect(await codec.decode(c, token)).toBeNull();
  });
});
