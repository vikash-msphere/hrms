// Dump the certificate chain out of a signed PDF, and say which trust anchor is missing.
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/esignChain.ts <signed.pdf>
//
// Answers the one question you cannot answer by reading docs: WHICH CCA root does our provider's chain
// actually terminate at? Every eSign PDF embeds the signer certificate and the licensed CA's intermediates
// in its CMS, but never the root - a document that could supply its own trust anchor could vouch for
// itself, so the anchor has to be pinned out of band. This walks the embedded certs issuer-by-issuer to the
// topmost one and prints the issuer name it points at but does not contain. That name is the certificate to
// fetch from https://cca.gov.in -> Repository and paste into PROD_ROOT_PEMS in web/src/lib/ccaRoots.ts.
//
// It also prints each certificate's SHA-256 fingerprint. When you download the root, compare its
// fingerprint against the value CCA publishes AND against a second independent source before trusting it -
// pasting an unverified trust anchor is the one step in this process that cannot be undone by a later fix.
import { readFileSync } from "node:fs";
import * as pkijs from "pkijs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --import ./scripts/tsResolve.mjs scripts/esignChain.ts <signed.pdf>");
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(file));
let pdfBin = "";
for (const b of bytes) pdfBin += String.fromCharCode(b);

// Mirrors extractRawSignatures() in web/src/lib/pdfSignature.ts: the detached PKCS#7 sits as hex between the
// two /ByteRange segments.
const sigs: Uint8Array[] = [];
for (const m of pdfBin.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
  const gap = pdfBin.slice(Number(m[1]) + Number(m[2]), Number(m[3]));
  const lt = gap.indexOf("<"), gt = gap.lastIndexOf(">");
  if (lt === -1 || gt <= lt) continue;
  const hex = gap.slice(lt + 1, gt).replace(/[^0-9a-fA-F]/g, "");
  const der = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < der.length; i++) der[i] = parseInt(hex.substr(i * 2, 2), 16);
  if (der.length) sigs.push(der);
}
if (!sigs.length) {
  console.error(`no /ByteRange signature found in ${file} - is it actually signed?`);
  process.exit(1);
}

const rdn = (name: pkijs.RelativeDistinguishedNames, oid: string) =>
  name.typesAndValues.filter((t) => t.type === oid).map((t) => String(t.value.valueBlock.value)).join(", ");
const describe = (n: pkijs.RelativeDistinguishedNames) =>
  [rdn(n, "2.5.4.3") || "(no CN)", rdn(n, "2.5.4.10"), rdn(n, "2.5.4.6")].filter(Boolean).join(" / ");
const same = (a: pkijs.RelativeDistinguishedNames, b: pkijs.RelativeDistinguishedNames) =>
  describe(a) === describe(b);

async function fingerprint(cert: pkijs.Certificate): Promise<string> {
  const der = cert.toSchema(true).toBER(false);
  const hash = await crypto.subtle.digest("SHA-256", der);
  return Array.from(new Uint8Array(hash)).map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

for (const [i, der] of sigs.entries()) {
  console.log(`\n=== signature ${i + 1} of ${sigs.length} ===`);
  const cms = new pkijs.ContentInfo({ schema: pkijs.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)).result });
  const sd = new pkijs.SignedData({ schema: cms.content });
  const certs = (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  if (!certs.length) { console.log("  no certificates embedded"); continue; }

  // Walk from the signer up: each step finds the cert whose SUBJECT is this cert's ISSUER.
  let current = certs[0]!;
  const seen = new Set<string>();
  for (let depth = 0; depth < 12; depth++) {
    const selfSigned = same(current.subject, current.issuer);
    console.log(`\n  [${depth}] ${depth === 0 ? "signer" : selfSigned ? "ROOT (self-signed, embedded)" : "intermediate"}`);
    console.log(`      subject : ${describe(current.subject)}`);
    console.log(`      issuer  : ${describe(current.issuer)}`);
    console.log(`      valid   : ${current.notBefore.value.toISOString().slice(0, 10)} -> ${current.notAfter.value.toISOString().slice(0, 10)}`);
    console.log(`      sha256  : ${await fingerprint(current)}`);

    if (selfSigned) break;
    const key = describe(current.subject);
    if (seen.has(key)) { console.log("      (issuer loop - stopping)"); break; }
    seen.add(key);

    const parent = certs.find((c) => same(c.subject, current.issuer) && !same(c.subject, current.subject));
    if (!parent) {
      console.log(`\n  >>> TRUST ANCHOR NEEDED: "${describe(current.issuer)}"`);
      console.log("      Not embedded in the PDF (correct - roots never are). Fetch exactly this certificate");
      console.log("      from https://cca.gov.in -> Repository, verify its published SHA-256 fingerprint,");
      console.log("      then paste the PEM into PROD_ROOT_PEMS in web/src/lib/ccaRoots.ts.");
      break;
    }
    current = parent;
  }
}
