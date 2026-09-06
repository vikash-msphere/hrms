// Generates e2e/fixtures/signed-unknown.pdf: a minimal single-page PDF carrying one real, PAdES-shaped
// PKCS#7/CMS detached signature (self-signed ECDSA P-256), for e2e coverage of the client-side signature
// validity stamp (web/src/lib/pdfSignature.ts + SignedPdfViewer). Self-signed on purpose: it exercises the
// "amber / unknown" path, which is the honest fallback this app draws for anything not chaining to a bundled
// CCA/eMudhra root - the same path a self-signed doc gets in the real app, and the only one a fixture built
// from scratch can legitimately claim without minting a fake CA. Uses the SAME libraries the app verifies
// with (pkijs + asn1js), so the fixture and the verifier speak one dialect.
//
// Not run by Playwright and not part of the app build - a one-off generator, checked in alongside its output.
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const crypto = webcrypto;
pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto }));

const CONTENTS_BYTES = 4096; // reserved space for the DER signature, zero-padded
const CONTENTS_HEX = CONTENTS_BYTES * 2;
const RANGE_WIDTH = 10; // fixed-width decimal field for each /ByteRange number

function pad(n) {
  return String(n).padStart(RANGE_WIDTH, "0");
}

// ---- 1. The PDF, with placeholder /ByteRange and /Contents -----------------------------------------------

const zeros = "0".repeat(CONTENTS_HEX);
const rangePlaceholder = `[0 ${pad(0)} ${pad(0)} ${pad(0)}]`;

function buildPdf(byteRangeText) {
  const enc = new TextEncoder();
  const objs = [];
  // 1: Catalog
  objs.push(`<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>`);
  // 2: Pages
  objs.push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  // 3: Page
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Annots [5 0 R] >>`);
  // 4: Signature dictionary
  objs.push(
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ` +
    `/ByteRange ${byteRangeText} /Contents <${zeros}> ` +
    `/M (D:20260101000000Z) /Reason (E2E fixture - self-signed, unknown trust) /Name (E2E Fixture Signer) >>`,
  );
  // 5: Signature widget annotation (visible, so the app's widget-position correlation has a real rect)
  objs.push(`<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [20 20 140 60] /F 132 /V 4 0 R /P 3 0 R /T (Signature1) >>`);
  // 6: AcroForm
  objs.push(`<< /Fields [5 0 R] /SigFlags 3 >>`);

  const header = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  let out = header;
  const offsets = [0]; // 1-indexed objects; offsets[0] unused
  for (let i = 0; i < objs.length; i++) {
    offsets.push(byteLength(out));
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = byteLength(out);
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += xref;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  // Latin1: every codepoint used above is <= 0xFF, so char code === byte value.
  return { text: out, bytes: Uint8Array.from(out, (c) => c.charCodeAt(0)) };

  function byteLength(s) {
    // Same "1 char = 1 byte" assumption as the final encode - fine since the PDF body is pure ASCII/Latin1.
    return s.length;
  }
}

// Pass 1: placeholder ByteRange, to find where `<` and `>` land.
const pass1 = buildPdf(rangePlaceholder);
const sigDictStart = pass1.text.indexOf("/Type /Sig");
const contentsAt = pass1.text.indexOf("/Contents <", sigDictStart);
const openIdx = contentsAt + "/Contents <".length - 1; // index of '<' itself
const closeIdx = pass1.text.indexOf(">", openIdx + 1);
if (openIdx < 0 || closeIdx < 0) throw new Error("could not locate the /Contents placeholder");

const a = 0;
const b = openIdx + 1;
const c = closeIdx;
const d = pass1.bytes.length - c;
const finalRangeText = `[${a} ${pad(b)} ${pad(c)} ${pad(d)}]`;
if (finalRangeText.length !== rangePlaceholder.length) throw new Error("ByteRange field width drifted between passes");

// Pass 2: the real ByteRange, same total length (so `<`/`>` positions are unchanged from pass 1).
const pass2 = buildPdf(finalRangeText);
if (pass2.bytes.length !== pass1.bytes.length) throw new Error("byte length changed between passes");
const bytes = pass2.bytes;

// The exact bytes the signature covers: everything except the /Contents hex itself.
const signed = new Uint8Array(b + d);
signed.set(bytes.subarray(a, a + b), 0);
signed.set(bytes.subarray(c, c + d), b);

// ---- 2. A self-signed ECDSA P-256 certificate ------------------------------------------------------------

const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

const cert = new pkijs.Certificate();
cert.version = 2;
cert.serialNumber = new asn1js.Integer({ value: 1 });
const cn = new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value: "HRMS E2E Fixture (self-signed)" }) });
cert.subject.typesAndValues.push(cn);
cert.issuer.typesAndValues.push(cn);
cert.notBefore.value = new Date("2026-01-01T00:00:00Z");
cert.notAfter.value = new Date("2036-01-01T00:00:00Z");
cert.extensions = [];
await cert.subjectPublicKeyInfo.importKey(keyPair.publicKey);
await cert.sign(keyPair.privateKey, "SHA-256");

// ---- 3. The CMS SignedData (detached), signed over exactly `signed` --------------------------------------

const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signed));

const signedAttrs = new pkijs.SignedAndUnsignedAttributes({
  type: 0,
  attributes: [
    new pkijs.Attribute({
      type: "1.2.840.113549.1.9.3", // content-type
      values: [new asn1js.ObjectIdentifier({ value: pkijs.SignedData.ID_DATA })],
    }),
    new pkijs.Attribute({
      type: "1.2.840.113549.1.9.4", // message-digest
      values: [new asn1js.OctetString({ valueHex: digest })],
    }),
    new pkijs.Attribute({
      type: "1.2.840.113549.1.9.5", // signing-time
      values: [new asn1js.UTCTime({ valueDate: new Date("2026-01-01T00:00:00Z") })],
    }),
  ],
});

const signerInfo = new pkijs.SignerInfo({
  version: 1,
  sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
  signedAttrs,
});

const signedData = new pkijs.SignedData({
  version: 1,
  encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: pkijs.SignedData.ID_DATA }), // detached: no eContent
  certificates: [cert],
  signerInfos: [signerInfo],
});

await signedData.sign(keyPair.privateKey, 0, "SHA-256", signed);

const cms = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signedData.toSchema(true) });
const der = new Uint8Array(cms.toSchema().toBER(false));
if (der.length > CONTENTS_BYTES) throw new Error(`CMS DER (${der.length}B) exceeds the reserved /Contents space (${CONTENTS_BYTES}B) - bump CONTENTS_BYTES`);

const hex = Array.from(der, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase().padEnd(CONTENTS_HEX, "0");
const hexBytes = Uint8Array.from(hex, (ch) => ch.charCodeAt(0));
bytes.set(hexBytes, openIdx + 1);

const outPath = join(here, "signed-unknown.pdf");
writeFileSync(outPath, bytes);
console.log(`wrote ${outPath} (${bytes.length} bytes, DER ${der.length}B of ${CONTENTS_BYTES}B reserved)`);
