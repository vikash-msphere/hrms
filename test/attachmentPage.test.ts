/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clampPageSize } from "../src/http/pagination";
import { attachedObjectIds, attachmentDisposition } from "../src/services/attachments";

// A FULL LIST PAGE OF IDS, which is what this function is actually handed.
//
// `attachedObjectIds` is a list `decorate` hook: six collections call it with `rows.map((r) => r.uuid)` for a
// whole page (reimbursements, expenses, leave-requests, candidates, referrals, tax-declarations). `inArray`
// spends one bound parameter per id, D1 admits 100 per statement (lib/dbBatch.ts PARAM_CAP), and the
// collection + slot equalities take two more - so the statement overflowed at 99 ids with
// `D1_ERROR: too many SQL variables`, uncaught, a 500 on the entire list. The SPA asks every list for
// `max_page_size=100` (web/src/api.ts), so all six pages failed outright once the org had ninety-nine of the
// thing, and worked perfectly on every dataset small enough to develop against.
//
// The case is derived from `clampPageSize` rather than written as 100, so raising the server's page cap
// re-aims this at the new ceiling instead of leaving it testing an old one.
const b = env as unknown as Bindings;
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const MAX_PAGE = clampPageSize(100_000);
let deps: Deps;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

describe("the attachment flag survives a full list page", () => {
  it("answers for the largest page the server will ever hand it", async () => {
    const ids = Array.from({ length: MAX_PAGE }, () => genId());
    await expect(attachedObjectIds(deps, "expenses", "invoice", ids)).resolves.toBeInstanceOf(Set);
  });

  it("still reports the right subset when the page spans several chunks", async () => {
    const ids = Array.from({ length: MAX_PAGE }, () => genId());
    // Attach a file to rows scattered across the page, including one past the first chunk boundary, so a
    // fix that chunked but dropped every group after the first would fail here rather than pass quietly.
    const attached = [ids[0]!, ids[45]!, ids[MAX_PAGE - 1]!];
    await deps.db.insert(schema.attachments).values(
      attached.map((objectId) => ({
        uuid: genId(), collection: "expenses", objectId, slot: "invoice",
        r2Key: `attachments/expenses/${objectId}/x`, fileName: "invoice.pdf", contentType: "application/pdf", sizeBytes: 1,
      })),
    );
    const got = await attachedObjectIds(deps, "expenses", "invoice", ids);
    expect([...got].sort()).toEqual([...attached].sort());
  });

  it("does not confuse one slot with another, chunked or not", async () => {
    const ids = Array.from({ length: MAX_PAGE }, () => genId());
    const other = ids[70]!;
    await deps.db.insert(schema.attachments).values({
      uuid: genId(), collection: "expenses", objectId: other, slot: "something-else",
      r2Key: `attachments/expenses/${other}/y`, fileName: "x.pdf", contentType: "application/pdf", sizeBytes: 1,
    });
    expect((await attachedObjectIds(deps, "expenses", "invoice", ids)).has(other)).toBe(false);
  });
});

// THE NAME THE FILE IS SAVED UNDER.
//
// Seven download routes answered with a bare `Content-Disposition: attachment` while the row they had just
// read carried the uploader's own name. With no name in the header the browser falls back to the request
// URL's last segment - for a custom method that is `<wire token>:downloadReceipt`, an extensionless file named
// after a token.
describe("an attachment download says what the file is called", () => {
  const nameIn = (h: string) => decodeURIComponent(h.match(/filename\*=UTF-8''(.*)$/)![1]!);

  it("uses the name the uploader gave the file", () => {
    const h = attachmentDisposition({ fileName: "Q3 receipt.pdf", contentType: "application/pdf" }, "receipt");
    expect(h.startsWith("attachment;")).toBe(true);
    expect(nameIn(h)).toBe("Q3 receipt.pdf");
  });

  it("falls back to a named file WITH the extension the stored type implies", () => {
    // Bytes posted by an integration carry no file name. "receipt" alone is unopenable; "receipt.jpg" is not.
    expect(nameIn(attachmentDisposition({ fileName: null, contentType: "image/jpeg" }, "receipt"))).toBe("receipt.jpg");
    expect(nameIn(attachmentDisposition({ fileName: null, contentType: "application/pdf" }, "proof"))).toBe("proof.pdf");
  });

  it("never doubles an extension the name already has", () => {
    expect(nameIn(attachmentDisposition({ fileName: "scan.png", contentType: "image/png" }, "resume"))).toBe("scan.png");
  });

  it("is still a well-formed header for a name that is trying not to be", () => {
    const h = attachmentDisposition({ fileName: 'a"b\r\nX-Evil: 1/../c.pdf', contentType: "application/pdf" }, "invoice");
    expect(h).not.toContain("\r");
    expect(h).not.toContain("\n");
    expect(h.match(/filename="([^"]*)"/)![1]).not.toContain('"');
  });
});
