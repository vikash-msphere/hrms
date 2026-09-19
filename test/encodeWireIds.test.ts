import { describe, it, expect } from "vitest";
import { makeIdCodec } from "../src/lib/idCodec";
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

  it("the same id under different collections encodes differently (collection-bound)", async () => {
    const out = await encodeWireIds(codec, { a: `employees/${EVE}`, b: `documents/${EVE}` });
    expect(out.a.split("/")[1]).not.toEqual(out.b.split("/")[1]);
  });
});
