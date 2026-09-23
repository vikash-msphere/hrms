// What the signature stamp is allowed to call "valid".
//
// `/ByteRange` is the SIGNER'S OWN CLAIM about which bytes the PKCS#7 covers, so verifying the digest over
// exactly those bytes always succeeds on a well-formed container - whatever else the file contains. A PDF is
// appendable: an incremental update can supersede every visible page while leaving the original trailer,
// `/ByteRange` and `/Contents` untouched, and the signature still verifies perfectly over bytes that are no
// longer what the document shows. Nothing here used to measure that, so `verifyPdfSignatures` reported
// "Signature valid - digitally signed by <the real signer>" over appended content, on a viewer that opens
// documents employees upload (web/src/pages/Documents.tsx).
//
// The maths that decides it is pure string arithmetic, so it is pinned directly rather than through a signed
// fixture: build a file whose ranges tile it, then make each of the ways they can fail to.
import { describe, it, expect } from "vitest";
import { extractRawSignatures } from "../web/src/lib/pdfSignature";

const CONTENTS = "<3082deadbeef>"; // a /Contents placeholder: the extractor only needs non-empty hex

/**
 * A minimal file shaped like a signed PDF.
 *
 * Offsets are zero-padded to a fixed width so the `/ByteRange` literal cannot change length when the numbers
 * are filled in - otherwise placing them would move the very bytes they point at.
 *
 *   `append`     - an incremental update written after the signed range (the attack).
 *   `shortStart` - the first range stops short of the container, leaving bytes nobody signed.
 *   `startAt`    - the first range begins past byte 0, leaving the header unsigned.
 */
function signedLike(opts: { append?: string; shortStart?: boolean; startAt?: number } = {}): string {
  const w = (n: number) => String(n).padStart(6, "0");
  const build = (a: number, b: number, c: number, d: number) =>
    `%PDF-1.7\n1 0 obj <</Type/Sig/ByteRange [${w(a)} ${w(b)} ${w(c)} ${w(d)}] /Contents ${CONTENTS}>>\nendobj\n2 0 obj <</Pages 3 0 R>> endobj\ntrailer\n%%EOF\n`;
  const probe = build(0, 0, 0, 0);
  const lt = probe.indexOf(CONTENTS);
  const gt = lt + CONTENTS.length;
  const start = opts.startAt ?? 0;
  const firstLen = (opts.shortStart ? lt - 5 : lt) - start;
  return build(start, firstLen, gt, probe.length - gt) + (opts.append ?? "");
}

describe("signature coverage", () => {
  it("reads a file whose ranges tile it as covering the document", () => {
    const sigs = extractRawSignatures(signedLike());
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.tilesFile).toBe(true);
    expect(sigs[0]!.reachesEnd).toBe(true);
  });

  it("tolerates trailing whitespace after the signed range", () => {
    expect(extractRawSignatures(signedLike({ append: "\n  \n" }))[0]!.reachesEnd).toBe(true);
  });

  // THE ONE THAT MATTERED. The signature still verifies over the original revision; the pages the reader is
  // looking at come from bytes written after it.
  it("reports an appended incremental update as not reaching the end", () => {
    const sigs = extractRawSignatures(signedLike({ append: "\n4 0 obj <</Pages 9 0 R>> endobj\ntrailer\n%%EOF\n" }));
    expect(sigs[0]!.tilesFile).toBe(true);
    expect(sigs[0]!.reachesEnd).toBe(false);
  });

  it("reports ranges that skip content before the container as not tiling the file", () => {
    expect(extractRawSignatures(signedLike({ shortStart: true }))[0]!.tilesFile).toBe(false);
  });

  it("reports a first range that does not start at byte 0 as not tiling the file", () => {
    expect(extractRawSignatures(signedLike({ startAt: 8 }))[0]!.tilesFile).toBe(false);
  });
});
