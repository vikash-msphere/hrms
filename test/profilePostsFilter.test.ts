/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { listAnnouncements } from "../src/services/announcements";
import { listSuggestions } from "../src/services/suggestions";

// The two server filters behind a profile's Posts tab - and the anonymity rule that one of them has to carry.
//
// The board and the box are both FEEDS. What one person wrote is scattered through them and mostly not in the
// first page of either, so "their posts" has to be a filter the DATABASE applies; narrowing a page in the
// browser would have shown a recent slice and called it somebody's history. That is the easy half.
//
// The hard half is the suggestion box. A suggestion can be submitted anonymously, and `toSuggestionResource`
// keeps that promise by dropping `submitter` from the wire entirely. A filter on the column BEHIND that
// dropped field hands the attribution straight back without any response ever naming anyone: ask for each
// employee in turn, and the anonymous rows sort themselves by author. So the filter excludes anonymous rows
// unless the caller is asking about themselves - you cannot break your own anonymity by looking at your own
// profile, and `own` is set on those rows anyway.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

let alice: string;
let bob: string;
beforeEach(async () => {
  // Replies first: they carry an FK to the post, so clearing the posts out from under them would leave rows
  // pointing at nothing and the next test's filter would match on them.
  await deps.db.delete(schema.announcementReplies);
  await deps.db.delete(schema.announcements);
  await deps.db.delete(schema.suggestions);
  await deps.db.delete(schema.employees);
  alice = genId();
  bob = genId();
  for (const [uuid, first] of [[alice, "Alice"], [bob, "Bob"]] as const) {
    await deps.db.insert(schema.employees).values({
      uuid, code: `04-${uuid.slice(0, 3)}`, firstName: first, lastName: "Poster",
      workEmail: `${uuid}@test.example`, status: "active",
    });
  }
});

const titles = (page: { items: { title: string | null }[] }) => page.items.map((r) => r.title).sort();

describe("a profile's Posts tab, server-side", () => {
  it("the board filter returns one author's posts and nobody else's", async () => {
    let i = 0;
    for (const [author, title] of [[alice, "alice one"], [alice, "alice two"], [bob, "bob one"]] as const) {
      await deps.db.insert(schema.announcements).values({
        uuid: genId(), code: `a-${i}`, title, body: title, kind: "post", published: true, disabled: false,
        authorEmployeeId: author, createdAt: new Date(1_700_000_000_000 + i * 1000), updatedAt: new Date(),
      });
      i++;
    }
    expect(titles(await listAnnouncements(deps, ALL, 50, undefined, false, undefined, undefined, false, `employees/${alice}`))).toEqual(["alice one", "alice two"]);
    expect(titles(await listAnnouncements(deps, ALL, 50, undefined, false, undefined, undefined, false, `employees/${bob}`))).toEqual(["bob one"]);
    // No filter is still the whole board - the parameter narrows and is not a new default.
    expect(titles(await listAnnouncements(deps, ALL, 50))).toEqual(["alice one", "alice two", "bob one"]);
  });

  it("the replied-to filter finds the conversations somebody joined, not the ones they started", async () => {
    // Bob's post; Alice replies to it. Alice also has a post of her own, which is NOT a conversation she
    // joined - that is the distinction the two filters draw, and the reason they are two filters.
    const bobsPost = genId();
    await deps.db.insert(schema.announcements).values({
      uuid: bobsPost, code: "a-0", title: "bob asks", body: "?", kind: "post", published: true, disabled: false,
      authorEmployeeId: bob, createdAt: new Date(1_700_000_000_000), updatedAt: new Date(),
    });
    await deps.db.insert(schema.announcements).values({
      uuid: genId(), code: "a-1", title: "alice announces", body: "!", kind: "post", published: true, disabled: false,
      authorEmployeeId: alice, createdAt: new Date(1_700_000_001_000), updatedAt: new Date(),
    });
    await deps.db.insert(schema.announcementReplies).values({
      uuid: genId(), announcementId: bobsPost, authorId: alice, authorEmail: "alice@test.example", body: "answered",
    });

    const repliedBy = (who: string) => listAnnouncements(deps, ALL, 50, undefined, false, undefined, undefined, false, undefined, `employees/${who}`);
    expect(titles(await repliedBy(alice))).toEqual(["bob asks"]);
    // Bob wrote the post but did not reply to it, so it is not a conversation he joined.
    expect(titles(await repliedBy(bob))).toEqual([]);
    // And the author filter is unmoved by any of it.
    expect(titles(await listAnnouncements(deps, ALL, 50, undefined, false, undefined, undefined, false, `employees/${alice}`))).toEqual(["alice announces"]);
  });

  it("the box filter hides an anonymous suggestion from everyone but its own submitter", async () => {
    let i = 0;
    for (const [submitter, title, anonymous] of [
      [alice, "alice signed", false],
      [alice, "alice anonymous", true],
      [bob, "bob signed", false],
    ] as const) {
      await deps.db.insert(schema.suggestions).values({
        uuid: genId(), code: `s-${i}`, submitterId: submitter, title, body: title, status: "new",
        anonymous, createdAt: new Date(1_700_000_000_000 + i * 1000), updatedAt: new Date(),
      });
      i++;
    }

    // Bob, on Alice's profile: her signed suggestion, and no sign that the anonymous one exists.
    expect(titles(await listSuggestions(deps, ALL, 50, { submitter: `employees/${alice}`, actorEmployeeId: bob })))
      .toEqual(["alice signed"]);
    // An unauthenticated / employee-less caller is not a special case - same answer.
    expect(titles(await listSuggestions(deps, ALL, 50, { submitter: `employees/${alice}`, actorEmployeeId: null })))
      .toEqual(["alice signed"]);
    // Alice, on her own: both, because she is not learning anything she did not already know.
    expect(titles(await listSuggestions(deps, ALL, 50, { submitter: `employees/${alice}`, actorEmployeeId: alice })))
      .toEqual(["alice anonymous", "alice signed"]);
  });

  it("the anonymity rule is the FILTER's, not the box's: an unfiltered read is unchanged", async () => {
    // The box lists anonymous suggestions to everyone - that is the point of it. What it does not do is say
    // whose they are, which is the serializer's job and is untouched here. So a plain read still returns the
    // anonymous row; only the by-submitter question is answered narrowly.
    await deps.db.insert(schema.suggestions).values({
      uuid: genId(), code: "s-0", submitterId: alice, title: "alice anonymous", body: "x", status: "new",
      anonymous: true, createdAt: new Date(), updatedAt: new Date(),
    });
    expect(titles(await listSuggestions(deps, ALL, 50, { actorEmployeeId: bob }))).toEqual(["alice anonymous"]);
  });
});
