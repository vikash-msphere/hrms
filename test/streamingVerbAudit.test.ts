/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
// @ts-expect-error - untyped module, runtime-only (same pattern as openapiRoutesDrift.test.ts)
import { load } from "js-yaml";
import { AUDIT, NON_SENSITIVE_STREAMING_VERBS } from "../src/domain/manifests";
import { READ_VERBS } from "../src/domain/auditAccess";

// TWO REGISTRIES DECIDE WHAT A CUSTOM METHOD'S AUDIT TRAIL LOOKS LIKE, AND THEY ASK DIFFERENT QUESTIONS.
//
//   AUDIT.sensitive_verbs (policy data) - does an ALLOWED read of this deserve a `<col>.read.sensitive` row?
//   READ_VERBS (a structural fact)      - does this handler change state? Absent means the write backstop in
//                                         middleware/authz.ts fires and files the call as a MUTATION.
//
// Every custom method is delivered as a POST (http/collectionRoute.ts mounts them all on `app.post("/:id")`),
// so a read-shaped verb missing from READ_VERBS is recorded as a write. That is not a missing trail, it is the
// wrong TYPE of trail: somebody asking "who opened this person's medical document" filters the feed by Viewed
// and gets nothing back, while the rows that exist sit under Other. `leave-requests:download` (the sick note
// behind a leave request) and `tickets:attachment` were in NEITHER registry, and so were `offers:letter`,
// `reviews:pdf` and the two letterhead renders.
//
// DERIVED FROM THE CONTRACT, not from the route files. A method streams bytes exactly when its success
// response is not JSON, and openapi.yaml says so per operation - while a route file names its collection in
// ways no parser can follow reliably (a `const COL`, a shared builder, several specs in one file, a
// collection-level method mounted from its own module). The contract is also already gated against the
// mounted routes (test/openapiRoutesDrift.ts), so nothing can stream bytes without appearing here.
const rawSpec = import.meta.glob("../openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
type Operation = { responses?: Record<string, { content?: Record<string, unknown> }> };
const paths = (load(Object.values(rawSpec)[0]!) as { paths: Record<string, { post?: Operation }> }).paths;

/** `<collection>:<verb>` for every custom method whose SUCCESS response is something other than JSON. */
const streaming = Object.entries(paths)
  .filter(([p]) => p.includes(":"))
  .filter(([, item]) => {
    const ok = Object.entries(item.post?.responses ?? {}).filter(([status]) => status.startsWith("2"));
    return ok.some(([, res]) => Object.keys(res?.content ?? {}).some((media) => media !== "application/json"));
  })
  .map(([p]) => {
    const verb = p.slice(p.lastIndexOf(":") + 1);
    const collection = p.slice("/v1/".length).split("/")[0]!.split(":")[0]!;
    return `${collection}:${verb}`;
  })
  .sort();

/**
 * Verbs that stream bytes AND change state, so they are correctly absent from READ_VERBS. Each needs its own
 * reason, because "it streams bytes" is otherwise indistinguishable from the gap this file exists to catch.
 */
const STREAMING_MUTATIONS: Record<string, string> = {
  "payroll-runs:bankFile": "also STAMPS the run (services/bankFile.ts) - handing the file to the bank is where the money leaves, and the stamp is irreversible, so both rows are written",
  "personal-documents:print": "freezes the rendered content into R2 beside the document (services/letterPrint.ts) so a printed letter is reproducible",
};

describe("every byte-streaming custom method is classified in both audit registries", () => {
  it("found the streaming methods (sanity: the contract shape still parses)", () => {
    expect(streaming.length).toBeGreaterThan(15);
    // The two this gate was written for, and one from each side of the classification.
    for (const pair of ["leave-requests:download", "tickets:attachment", "payslips:download", "org-documents:download"]) {
      expect(streaming, `${pair} should be in the derived streaming set`).toContain(pair);
    }
    // ...and nothing that answers with JSON.
    for (const pair of ["payroll-runs:publish", "access-rules:preview", "automations:test"]) {
      expect(streaming).not.toContain(pair);
    }
  });

  it("files each one as a read, or names it as a mutation with a reason", () => {
    const unclassified = streaming.filter((v) => !READ_VERBS.has(v) && !STREAMING_MUTATIONS[v]);
    expect(
      unclassified,
      "streams bytes but is in neither READ_VERBS nor STREAMING_MUTATIONS - the write backstop will file this read as a change to the record",
    ).toEqual([]);
  });

  it("decides sensitivity for every streaming READ, either way", () => {
    const reads = streaming.filter((v) => READ_VERBS.has(v));
    const undecided = reads.filter((v) => !AUDIT.sensitive_verbs.includes(v) && !NON_SENSITIVE_STREAMING_VERBS[v]);
    expect(
      undecided,
      "streams bytes and is neither audited as sensitive nor documented as exempt - decide it in AUDIT.sensitive_verbs or NON_SENSITIVE_STREAMING_VERBS",
    ).toEqual([]);
  });

  it("never marks the same verb both sensitive and exempt", () => {
    expect(AUDIT.sensitive_verbs.filter((v) => NON_SENSITIVE_STREAMING_VERBS[v])).toEqual([]);
  });

  it("keeps every sensitive verb out of the write backstop, except the one that really does write", () => {
    // A sensitive READ filed as a mutation is the `payroll-runs:bankFile` shape - deliberate there, because
    // that handler also stamps the run. Anywhere else it is the bug.
    expect(AUDIT.sensitive_verbs.filter((v) => !READ_VERBS.has(v) && !STREAMING_MUTATIONS[v])).toEqual([]);
  });

  it("carries no stale exemption", () => {
    expect(
      Object.keys(NON_SENSITIVE_STREAMING_VERBS).filter((v) => !streaming.includes(v)),
      "exempted from the sensitive-read trail but no longer a streaming custom method",
    ).toEqual([]);
    expect(Object.keys(STREAMING_MUTATIONS).filter((v) => !streaming.includes(v))).toEqual([]);
  });

  it("gives every exemption an actual reason", () => {
    const thin = Object.entries(NON_SENSITIVE_STREAMING_VERBS).filter(([, why]) => why.trim().length < 20).map(([v]) => v);
    expect(thin, "an exemption without a reason is an omission with a comment next to it").toEqual([]);
  });
});

describe("the documents this finding was about", () => {
  it("audits the sick note behind a leave request as a sensitive read", () => {
    // REDACTED_FIELDS already classifies the request's own `reason` as routinely medical, so the app redacted
    // the one-line summary and streamed the doctor's letter it summarises with no read row at all.
    expect(AUDIT.sensitive_verbs).toContain("leave-requests:download");
    expect(READ_VERBS.has("leave-requests:download")).toBe(true);
  });

  it("audits a ticket attachment the same way the ticket's own text is redacted", () => {
    expect(AUDIT.sensitive_verbs).toContain("tickets:attachment");
    expect(READ_VERBS.has("tickets:attachment")).toBe(true);
  });

  it("puts a claim receipt beside the rent receipts it is indistinguishable from", () => {
    expect(AUDIT.sensitive_verbs).toContain("reimbursements:download");
    expect(AUDIT.sensitive_verbs).toContain("tax-declarations:download");
  });
});
