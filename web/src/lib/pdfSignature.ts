// Client-side verification of the embedded PKCS#7 / PAdES digital signature(s) in a signed PDF. Runs ENTIRELY
// in the browser (WebCrypto via PKI.js) - the server is never asked and the PDF bytes are never modified. This
// is what Adobe/eMudhra viewers do to draw the validity icon: read each /ByteRange + /Contents signature,
// verify the signed digest + signature (integrity & authenticity), and check the signer cert chains to a
// trusted CA root. Maps onto the universal three-state language: valid (green) / invalid (red) / unknown (amber).
//
// PKI.js (not node-forge) is used deliberately: modern Aadhaar eSign certificates are ECDSA, which node-forge
// cannot parse or verify. PKI.js verifies both ECDSA and RSA through WebCrypto. This module is dynamically
// imported by the viewer, so PKI.js stays out of the main bundle until a signature is actually inspected.
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { TRUSTED_ROOT_PEMS } from "./ccaRoots";

export type SignatureValidity = "valid" | "invalid" | "unknown";

export type SignatureResult = {
  validity: SignatureValidity;
  integrity: boolean; // signed content digest + signature verify (document not altered, signature authentic)
  trusted: boolean; // signer cert chains to a bundled trusted root (as of signing time)
  signerName?: string; // subject CN of the signer certificate
  serialNumber?: string; // certificate serial (hex)
  signingTime?: string; // ISO string, from the signed signing-time attribute if present
  reason?: string; // PDF /Reason, if present
  location?: string; // PDF /Location, if present
  error?: string;
};

// Ensure PKI.js has a crypto engine (browser: globalThis.crypto.subtle). Idempotent.
let engineReady = false;
function ensureEngine() {
  if (engineReady) return;
  try {
    if (!pkijs.getCrypto()) pkijs.setEngine("hrms", new pkijs.CryptoEngine({ name: "hrms", crypto: globalThis.crypto }));
  } catch { /* getCrypto throws when unset; set it */ try { pkijs.setEngine("hrms", new pkijs.CryptoEngine({ name: "hrms", crypto: globalThis.crypto })); } catch { /* noop */ } }
  engineReady = true;
}

type RawSig = { byteRange: [number, number, number, number]; der: Uint8Array; dictStart: number };

function toBinary(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function hexToLatin1(hex: string): string {
  const b = hexToBytes(hex);
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

// Read the four /ByteRange integers and the /Contents (detached PKCS#7) for every signature. The /Contents hex
// occupies the gap between the two byte-range segments; PDFs zero-pad it, which is fine (BER stops at the SEQ).
function extractRawSignatures(pdfBin: string): RawSig[] {
  const out: RawSig[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pdfBin))) {
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
    const gap = pdfBin.slice(a + b, c);
    const lt = gap.indexOf("<"), gt = gap.lastIndexOf(">");
    if (lt === -1 || gt === -1 || gt <= lt) continue;
    const der = hexToBytes(gap.slice(lt + 1, gt));
    if (!der.length) continue;
    out.push({ byteRange: [a, b, c, d], der, dictStart: m.index });
  }
  return out;
}

// Best-effort parse of a PDF string value for /Reason and /Location near a signature dict: literal `(...)` or
// hex `<...>` (possibly UTF-16BE with a BOM). Returns undefined when absent.
function pdfStringAfter(pdfBin: string, key: string, from: number): string | undefined {
  const idx = pdfBin.indexOf(key, from);
  if (idx === -1 || idx > from + 4000) return undefined;
  let i = idx + key.length;
  while (i < pdfBin.length && /\s/.test(pdfBin[i]!)) i++;
  if (pdfBin[i] === "(") {
    let j = i + 1, depth = 1, s = "";
    while (j < pdfBin.length && depth > 0) {
      const ch = pdfBin[j]!;
      if (ch === "\\") { s += pdfBin[j + 1] ?? ""; j += 2; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
      s += ch; j++;
    }
    return s || undefined;
  }
  if (pdfBin[i] === "<") {
    const end = pdfBin.indexOf(">", i);
    if (end === -1) return undefined;
    const bin = hexToLatin1(pdfBin.slice(i + 1, end));
    if (bin.charCodeAt(0) === 0xfe && bin.charCodeAt(1) === 0xff) {
      let s = ""; for (let k = 2; k + 1 < bin.length; k += 2) s += String.fromCharCode((bin.charCodeAt(k) << 8) | bin.charCodeAt(k + 1));
      return s || undefined;
    }
    return bin || undefined;
  }
  return undefined;
}

function subjectCN(cert: pkijs.Certificate): string | undefined {
  for (const t of cert.subject.typesAndValues) if (t.type === "2.5.4.3") return String(t.value.valueBlock.value);
  return undefined;
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const trustedCache = { built: false, certs: [] as pkijs.Certificate[] };
function trustedRoots(): pkijs.Certificate[] {
  if (trustedCache.built) return trustedCache.certs;
  const certs: pkijs.Certificate[] = [];
  for (const pem of TRUSTED_ROOT_PEMS) {
    try {
      const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
      certs.push(pkijs.Certificate.fromBER(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
    } catch { /* skip a malformed root */ }
  }
  trustedCache.built = true; trustedCache.certs = certs;
  return certs;
}

async function verifyOne(pdfBin: string, raw: RawSig): Promise<SignatureResult> {
  try {
    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(ab(raw.der)).result });
    const sd = new pkijs.SignedData({ schema: ci.content });

    const [a, b, c, d] = raw.byteRange;
    const signed = new Uint8Array(b + d);
    // ByteRange segments come from the ORIGINAL bytes; rebuild them from the binary string we already hold.
    for (let i = 0; i < b; i++) signed[i] = pdfBin.charCodeAt(a + i) & 0xff;
    for (let i = 0; i < d; i++) signed[b + i] = pdfBin.charCodeAt(c + i) & 0xff;

    // INTEGRITY + AUTHENTICITY: verify the signed digest + the signature over the signed attributes.
    let integrity = false;
    try {
      const res: any = await sd.verify({ signer: 0, data: ab(signed), checkChain: false, extendedMode: true });
      integrity = res === true || res?.signatureVerified === true;
    } catch { integrity = false; }

    const signer = sd.certificates?.[0] as pkijs.Certificate | undefined;

    // signing time attribute (1.2.840.113549.1.9.5)
    let signingTime: string | undefined;
    for (const attr of sd.signerInfos[0]?.signedAttrs?.attributes ?? []) {
      if (attr.type === "1.2.840.113549.1.9.5") { try { signingTime = (attr.values[0] as any).toDate().toISOString(); } catch { /* ignore */ } }
    }

    // TRUST: signer cert chains to a bundled root, checked AS OF the signing time (eSign certs are short-lived,
    // so validating "now" would wrongly reject a signature that was valid when made).
    let trusted = false;
    const roots = trustedRoots();
    if (signer && roots.length) {
      try {
        const engine = new pkijs.CertificateChainValidationEngine({
          trustedCerts: roots,
          certs: (sd.certificates ?? []) as pkijs.Certificate[],
          verificationTime: signingTime ? new Date(signingTime) : new Date(),
        } as any);
        const r: any = await engine.verify();
        trusted = r?.result === true;
      } catch { trusted = false; }
    }

    const validity: SignatureValidity = !integrity ? "invalid" : trusted ? "valid" : "unknown";
    const serial = signer ? Array.from(new Uint8Array(signer.serialNumber.valueBlock.valueHexView)).map((x) => x.toString(16).padStart(2, "0")).join("") : undefined;

    return {
      validity, integrity, trusted,
      signerName: signer ? subjectCN(signer) : undefined,
      serialNumber: serial,
      signingTime,
      reason: pdfStringAfter(pdfBin, "/Reason", raw.dictStart),
      location: pdfStringAfter(pdfBin, "/Location", raw.dictStart),
    };
  } catch (e) {
    return { validity: "unknown", integrity: false, trusted: false, error: (e as Error).message || "could not parse signature" };
  }
}

// Verify every embedded signature in the PDF. Returns [] when the file carries no digital signature.
export async function verifyPdfSignatures(bytes: Uint8Array): Promise<SignatureResult[]> {
  ensureEngine();
  const pdfBin = toBinary(bytes);
  const raws = extractRawSignatures(pdfBin);
  const out: SignatureResult[] = [];
  for (const raw of raws) out.push(await verifyOne(pdfBin, raw));
  return out;
}
