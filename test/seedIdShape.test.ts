/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import seedSql from "../scripts/seed.sql?raw";
import bootstrapSql from "../bootstrap/bootstrap.sql?raw";
import demoSql from "../bootstrap/demo.sql?raw";
import { base32ToBytes, bytesToBase32 } from "../src/lib/idCodec";

// An internal id is 8 bytes rendered as 13 Crockford-base32 chars, and the wire codec encodes nothing else:
// it must also ROUND-TRIP: 13 chars carry 65 bits, so the last char's low bit is padding, and an id whose
// final char sets it (`...4d`) decodes to a DIFFERENT string (`...4c`) than the row it was minted for - the
// item path then 404s on a row the list just returned. Both halves are checked below.
// a list cursor tokenizes the last row's uuid, so a fixture id of any other shape turns the FIRST paged list
// of that collection into a 500 (`idCodec.encode: id is not an 8-byte base32 string`) - which is exactly what
// the hand-written `arseed000` rules did to GET /v1/access-rules. Every seeded uuid is checked here, so a
// fixture can never again carry an id the app itself could not have minted.
const uuidsIn = (sql: string): { table: string; id: string }[] => {
  const out: { table: string; id: string }[] = [];
  for (const m of sql.matchAll(/INSERT INTO (\w+) \(uuid[^)]*\) VALUES([\s\S]*?);\n/g)) {
    for (const v of m[2]!.matchAll(/\(\s*'([^']*)'/g)) out.push({ table: m[1]!, id: v[1]! });
  }
  return out;
};

describe.each([
  ["scripts/seed.sql", seedSql],
  ["bootstrap/bootstrap.sql", bootstrapSql],
  ["bootstrap/demo.sql", demoSql],
])("%s seeds encodable ids", (_name, sql) => {
  it("every seeded uuid is a real 13-char base32 internal id", () => {
    const rows = uuidsIn(sql);
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => {
      const bytes = r.id.length === 13 ? base32ToBytes(r.id, 8) : null;
      return bytes === null || bytesToBase32(bytes) !== r.id;
    });
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
