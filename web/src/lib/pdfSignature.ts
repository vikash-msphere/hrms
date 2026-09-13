// Client-side verification of the embedded PKCS#7 / PAdES digital signature(s) in a signed PDF. Runs ENTIRELY
// in the browser (WebCrypto via PKI.js) - the server is never asked and the PDF bytes are never modified. This
// is what Adobe/eMudhra viewers do to draw the validity icon: read each /ByteRange + /Contents signature,
// verify the signed digest + signature (integrity & authenticity), and check the signer cert chains to a
// trusted CA root. Maps onto the universal three-state language: valid (green) / invalid (red) / unknown (amber).
//
// PKI.js (not node-forge) is used deliberately: modern Aadhaar eSign certificates are ECDSA, which node-forge
// cannot parse or verify. PKI.js verifies both ECDSA and RSA through WebCrypto. This module is dynamically
// imported by the viewer, so PKI.js stays out of the main bundle until a signature is actually inspected.
//
// Two known limits, neither reachable with Indian Aadhaar eSign today: results are correlated to signature
// widgets by document order, which is exact for the single-signer case but would need field-name matching if
// multi-signer PDFs ever appear; and WebCrypto only implements ECDSA over P-256/384/521, so a signer on an
// exotic curve verifies as "unknown" (amber) rather than valid.
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { TRUSTED_ROOT_PEMS } from "./ccaRoots";

export type SignatureValidity = "valid" | "invalid" | "unknown";

export type SignatureResult = {
  validity: SignatureValidity;
  integrity: boolean; // signed content digest + signature verify (document not altered, signature authentic)
  trusted: boolean; // signer cert chains to a bundled trusted root (as of signing time)
  /**
   * The signed byte ranges account for the WHOLE file - everything except the signature container itself.
   *
   * Separate from `integrity`, and the distinction is the point. `/ByteRange` is the signer's own claim about
   * which bytes are covered, so verifying "the bytes it named" always succeeds on a well-formed container,
   * whatever else is in the file. A PDF is appendable: an incremental update can supersede every visible page
   * while leaving the original trailer, `/ByteRange` and `/Contents` untouched, and the PKCS#7 still verifies
   * perfectly - over bytes that are no longer what the document shows. Adobe reports this separately ("the
   * signature covers only part of the document"); here it decides `validity`, because a stamp that says
   * "Signature valid" over content nobody signed is worse than no stamp at all.
   */
  coversDocument: boolean;
  signerName?: string; // subject CN of the signer certificate
  serialNumber?: string; // certificate serial (hex)
  signingTime?: string; // ISO string, from the signed signing-time attribute if present
  reason?: string; // PDF /Reason, if present
  location?: string; // PDF /Location, if present
  /** Why this is not a plain "valid" - shown under the stamp, so a refusal says what it saw. */
  note?: string;
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

type RawSig = {
  byteRange: [number, number, number, number];
  der: Uint8Array;
  dictStart: number;
  /** The two ranges are `[0, contents-start]` and `[contents-end, …]` - i.e. they omit the container and
   *  nothing else. False means the signer named a window rather than the file. */
  tilesFile: boolean;
  /** Nothing but whitespace follows the second range: no later revision was appended after this signature. */
  reachesEnd: boolean;
};

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
//
// AND WHAT THE RANGES LEAVE OUT, which is the half that decides whether verifying them means anything. Two
// properties are measured here, while the offsets are in hand:
//
//   `tilesFile`  - the first range starts at byte 0 and ends exactly where `<` begins, and the second resumes
//                  immediately after `>`. So the covered bytes are the file minus the signature container, and
//                  nothing else is hidden in a gap the signer declined to sign.
//   `reachesEnd` - nothing but whitespace follows the second range. This is what an appended incremental
//                  update breaks: the original signature still verifies over the original revision while the
//                  pages the reader is looking at come from bytes written after it.
//
// Trailing whitespace is tolerated (some producers end the range before a final newline, and whitespace cannot
// change what renders); any non-space byte past the range is a later revision and is reported as one.
// Exported for test/pdfSignatureCoverage.test.ts: the coverage decision is the part with security meaning and
// it is pure string arithmetic, so it is worth pinning without a real signed PDF to hand.
export function extractRawSignatures(pdfBin: string): RawSig[] {
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
    // Everything between the end of range 1 and the `<`, and between the `>` and the start of range 2, must be
    // whitespace - otherwise the ranges skip real content.
    const tilesFile = a === 0 && gap.slice(0, lt).trim() === "" && gap.slice(gt + 1).trim() === "";
    const reachesEnd = c + d <= pdfBin.length && pdfBin.slice(c + d).trim() === "";
    out.push({ byteRange: [a, b, c, d], der, dictStart: m.index, tilesFile, reachesEnd });
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

const hexOf = (view: Uint8Array): string => Array.from(view).map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * THE certificate that made this signature, resolved from the SignerInfo rather than guessed.
 *
 * `sd.certificates[0]` is whatever the producer put first in the bag, and a PKCS#7 that carries a chain
 * routinely leads with an intermediate CA. `sd.verify({ signer: 0 })` always resolved the right one internally,
 * so the maths was never wrong - but the NAME, serial and trust anchor shown on the stamp came from the bag's
 * first entry, which is how a stamp ends up attributing a signature to the wrong subject with a green tick
 * beside it. The SignerInfo names its certificate either by issuer + serial or by subject key identifier;
 * both are honoured, and `certificates[0]` remains the last resort so an unusual container still renders.
 */
function signerCertificate(sd: pkijs.SignedData): pkijs.Certificate | undefined {
  const certs = (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  const sid = sd.signerInfos?.[0]?.sid as any;
  try {
    if (sid?.serialNumber && sid?.issuer) {
      const want = hexOf(new Uint8Array(sid.serialNumber.valueBlock.valueHexView));
      const match = certs.find(
        (c) => hexOf(new Uint8Array(c.serialNumber.valueBlock.valueHexView)) === want && c.issuer.isEqual(sid.issuer),
      );
      if (match) return match;
    }
    // SubjectKeyIdentifier form: the sid IS the key id, matched against each certificate's own SKI extension.
    const ski = sid?.valueBlock?.valueHexView ? hexOf(new Uint8Array(sid.valueBlock.valueHexView)) : null;
    if (ski) {
      const match = certs.find((c) => {
        const ext = c.extensions?.find((e) => e.extnID === "2.5.29.14");
        const raw = (ext?.parsedValue as any)?.valueBlock?.valueHexView ?? (ext as any)?.extnValue?.valueBlock?.valueHexView;
        return raw ? hexOf(new Uint8Array(raw)).endsWith(ski) : false;
      });
      if (match) return match;
    }
  } catch {
    /* an unusual sid shape: fall through to the bag's first certificate */
  }
  return certs[0];
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

/**
 * Verify one signature.
 *
 * `isLast` says whether this is the newest signature in the file, and it is what makes the coverage rule usable
 * on a multi-signer document: in a countersigned PDF each earlier signature legitimately stops short of the end
 * (the next signer's revision was appended after it), so only the LAST one is expected to reach EOF. Earlier
 * ones still have to TILE - start at 0 and omit nothing but their own container - because that property has
 * nothing to do with who signed afterwards.
 */
async function verifyOne(pdfBin: string, raw: RawSig, isLast: boolean): Promise<SignatureResult> {
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

    const signer = signerCertificate(sd);

    // signing time attribute (1.2.840.113549.1.9.5)
    let signingTime: string | undefined;
    for (const attr of sd.signerInfos[0]?.signedAttrs?.attributes ?? []) {
      if (attr.type === "1.2.840.113549.1.9.5") { try { signingTime = (attr.values[0] as any).toDate().toISOString(); } catch { /* ignore */ } }
    }

    // An RFC 3161 timestamp token (1.2.840.113549.1.9.16.2.14) is what makes a signing time somebody ELSE's
    // claim. Without one the time below is asserted by the signer - covered by the signature, but chosen by
    // them - which is exactly the moment a holder of a since-revoked or since-expired certificate would pick.
    const timestamped = (sd.signerInfos[0]?.unsignedAttrs?.attributes ?? []).some((a) => a.type === "1.2.840.113549.1.9.16.2.14");

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

    // COVERAGE, decided before validity. See `coversDocument` on the result type: the digest above proves only
    // that the bytes the signature NAMED are unaltered, and a file can carry any amount of content those bytes
    // do not include. A signature over part of a document is not a signature over the document, so it can never
    // read "valid", however cleanly it verifies and however well its certificate chains.
    const coversDocument = raw.tilesFile && (isLast ? raw.reachesEnd : true);
    const coverageNote = !raw.tilesFile
      ? "the signature covers only part of the file"
      : !raw.reachesEnd && isLast
        ? "the document was changed after it was signed (content was appended)"
        : undefined;

    const validity: SignatureValidity = !integrity ? "invalid" : !coversDocument ? "invalid" : trusted ? "valid" : "unknown";
    const serial = signer ? hexOf(new Uint8Array(signer.serialNumber.valueBlock.valueHexView)) : undefined;

    return {
      validity, integrity, trusted, coversDocument,
      signerName: signer ? subjectCN(signer) : undefined,
      serialNumber: serial,
      signingTime,
      reason: pdfStringAfter(pdfBin, "/Reason", raw.dictStart),
      location: pdfStringAfter(pdfBin, "/Location", raw.dictStart),
      // A "Signature valid" stamp with nothing under it is read as more than it means. Verification here is
      // deliberately OFFLINE (the header: "the server is never asked"), which costs two things the green tick
      // would otherwise imply: the engine is given no `crls` and no `ocsps`, so a REVOKED certificate that
      // still chains to a bundled root verifies clean; and without a timestamp token the chain is validated as
      // of a time the signer chose. Say so on the stamp - the viewer already renders `note` under the label.
      note:
        coverageNote ??
        (integrity && !trusted
          ? "the signer's certificate does not chain to a trusted root"
          : validity === "valid"
            ? `checked offline: revocation not checked${timestamped ? "" : ", and the signing time is the signer's own"}`
            : undefined),
    };
  } catch (e) {
    return { validity: "unknown", integrity: false, trusted: false, coversDocument: false, error: (e as Error).message || "could not parse signature" };
  }
}

// Verify every embedded signature in the PDF. Returns [] when the file carries no digital signature.
//
// Document order is revision order (each incremental update appends), so the LAST entry is the newest
// signature - the one whose ranges have to reach the end of the file. See verifyOne's `isLast`.
export async function verifyPdfSignatures(bytes: Uint8Array): Promise<SignatureResult[]> {
  ensureEngine();
  const pdfBin = toBinary(bytes);
  const raws = extractRawSignatures(pdfBin);
  const out: SignatureResult[] = [];
  for (let i = 0; i < raws.length; i++) out.push(await verifyOne(pdfBin, raws[i]!, i === raws.length - 1));
  return out;
}
