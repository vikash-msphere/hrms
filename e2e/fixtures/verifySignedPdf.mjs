// Sanity-checks signed-unknown.pdf the same way web/src/lib/pdfSignature.ts does, plus that pdf.js can open
// it and see the signature widget. Dev tooling only - not part of the app or the Playwright run.
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto }));

const bytes = readFileSync(join(here, "signed-unknown.pdf"));
let pdfBin = "";
for (let i = 0; i < bytes.length; i++) pdfBin += String.fromCharCode(bytes[i]);

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function ab(u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }

const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
const m = re.exec(pdfBin);
if (!m) throw new Error("no /ByteRange found");
const [a, b, c, d] = m.slice(1).map(Number);
const gap = pdfBin.slice(a + b, c);
const lt = gap.indexOf("<"), gt = gap.lastIndexOf(">");
const der = hexToBytes(gap.slice(lt + 1, gt));
console.log("DER bytes:", der.length);

const signed = new Uint8Array(b + d);
for (let i = 0; i < b; i++) signed[i] = pdfBin.charCodeAt(a + i) & 0xff;
for (let i = 0; i < d; i++) signed[b + i] = pdfBin.charCodeAt(c + i) & 0xff;

const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(ab(der)).result });
const sd = new pkijs.SignedData({ schema: ci.content });
const res = await sd.verify({ signer: 0, data: ab(signed), checkChain: false, extendedMode: true });
console.log("verify result:", res);

// Same trust check the app runs, against an EMPTY trusted-root set (self-signed must not chain) - equivalent
// to the amber/"unknown" case in ccaRoots.ts unless this exact test cert were ever added there.
const engine = new pkijs.CertificateChainValidationEngine({ trustedCerts: [], certs: sd.certificates ?? [] });
const chain = await engine.verify().catch((e) => ({ result: false, error: String(e) }));
console.log("chain result (expect false/untrusted):", chain.result, chain.resultMessage ?? chain.error ?? "");

console.log("=> validity would be:", !res.signatureVerified ? "invalid" : chain.result ? "valid" : "unknown");

// pdf.js: can it open the file and see the Sig widget?
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
console.log("pages:", doc.numPages);
const page = await doc.getPage(1);
const annots = await page.getAnnotations();
console.log("annotations:", annots.map((x) => ({ fieldType: x.fieldType, rect: x.rect })));
