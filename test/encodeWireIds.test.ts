import { describe, it, expect } from "vitest";
import { makeIdCodec, isInternalId, genId } from "../src/lib/idCodec";
import { encodeWireIds, collectRefs } from "../src/middleware/encodeWireIds";

const KEY = Buffer.alloc(32, 7).toString("base64");
const codec = makeIdCodec(KEY);
const EVE = "2cn3wk30dszr6";
const DEPT = "20n3pk2xdszr0";

describe("encodeWireIds", () => {
  it("encodes path, refs, and photo :verb keys; leaves plain fields", async () => {
    const out = await encodeWireIds(codec, {
      path: `employees/${EVE}`,
      department: `departments/${DEPT}`,
      photo: `employees/${EVE}:getPhoto`,
      first_name: "Eve",
      work_email: "emp@example.com",
    });
    // tokens replaced the internal ids, decode back to them
    const pathToken = out.path.split("/")[1]!;
    expect(pathToken).toHaveLength(26);
    expect(await codec.decode("employees", pathToken)).toEqual(EVE);
    expect(await codec.decode("departments", out.department.split("/")[1]!)).toEqual(DEPT);
    expect(out.photo).toMatch(/^employees\/.{26}:getPhoto$/);
    expect(out.first_name).toEqual("Eve");
    expect(out.work_email).toEqual("emp@example.com"); // not collection/id shaped
  });

  it("encodes a deep link's id and keeps the trailing route segment", async () => {
    // A notification's link is a web route into one record ("announcements/<id>/view"), so the id sits in the
    // middle of the string. It still has to leave as a token, with the `/view` tail intact.
    const out = await encodeWireIds(codec, { link: `announcements/${EVE}/view` });
    const [, token, tail] = out.link.split("/");
    expect(tail).toEqual("view");
    expect(await codec.decode("announcements", token!)).toEqual(EVE);
  });

  // THE REGRESSION THAT SHIPPED, and the fixture that would have caught it. The photo marker grew a version
  // (`?v=<photo_at>`, http/serialize.ts) and the anchored ref pattern stopped matching it - so the row's
  // `photo` carried the employee's INTERNAL primary key to every client, while `signature` next to it, same
  // shape without a query, left as a token. The case above passes either way, which is precisely why nothing
  // said anything for as long as it did.
  it("encodes a ref that carries a query string, and keeps the query", async () => {
    const out = await encodeWireIds(codec, {
      photo: `employees/${EVE}:getPhoto?v=1758000000000`,
      link: `announcements/${EVE}/view?tab=replies`,
    });
    expect(out.photo).toMatch(/^employees\/.{26}:getPhoto\?v=1758000000000$/);
    expect(out.photo).not.toContain(EVE);
    expect(await codec.decode("employees", out.photo.slice("employees/".length, "employees/".length + 26))).toEqual(EVE);
    expect(out.link).toMatch(/^announcements\/.{26}\/view\?tab=replies$/);
  });

  it("walks lists and leaves the pagination cursor untouched", async () => {
    const cursor = Buffer.from(`1700000000000|tok`).toString("base64url");
    const out = await encodeWireIds(codec, {
      results: [{ path: `employees/${EVE}` }, { path: `departments/${DEPT}` }],
      next_page_token: cursor,
    });
    expect(out.results[0]!.path.split("/")[1]).toHaveLength(26);
    expect(out.next_page_token).toEqual(cursor); // base64url has no '/', never matched
  });

  it("does not touch key-based or unknown-collection strings", async () => {
    const refs = new Set<string>();
    collectRefs({ a: "settings/holidays", b: "preferences/table-layout", c: `foo/${EVE}` }, refs);
    expect(refs.size).toEqual(0); // settings/preferences excluded; foo not a known collection
  });

  it("leaves an id-SHAPED string that is not a canonical id untouched instead of failing the response", async () => {
    // 13 alphabet characters whose last one carries the spare 65th bit: the regex matches, the codec cannot
    // encode it. User text shaped like this used to make the whole response a 500 for every reader.
    const bogus = "zzzzzzzzzzzzz";
    const out = await encodeWireIds(codec, { title: `goals/${bogus}`, path: `goals/${EVE}` });
    expect(out.title).toEqual(`goals/${bogus}`);
    expect(await codec.decode("goals", out.path.split("/")[1]!)).toEqual(EVE);
  });

  it("the same id under different collections encodes differently (collection-bound)", async () => {
    const out = await encodeWireIds(codec, { a: `employees/${EVE}`, b: `documents/${EVE}` });
    expect(out.a.split("/")[1]).not.toEqual(out.b.split("/")[1]);
  });
});

describe("isInternalId", () => {
  it("accepts minted ids and refuses non-canonical, wrong-length and foreign strings", () => {
    for (let i = 0; i < 50; i++) expect(isInternalId(genId())).toBe(true);
    expect(isInternalId(EVE)).toBe(true);
    expect(isInternalId("zzzzzzzzzzzzz")).toBe(false); // spare bit set
    expect(isInternalId("abc")).toBe(false);
    expect(isInternalId(`${EVE}0`)).toBe(false);
    expect(isInternalId("ILOU000000000")).toBe(false); // outside the alphabet
    expect(isInternalId(undefined)).toBe(false);
  });
});
