// The eSign trust store is the one place in this codebase where a wrong value is not a bug but a forged
// signature displayed as genuine. TRUSTED_ROOT_PEMS decides whether a signed document renders green
// "valid" or amber "unknown" (web/src/lib/pdfSignature.ts), so a root swapped for an attacker's - by a bad
// merge, a copy-paste from the wrong tab, or deliberately - would make documents signed by that attacker
// verify as real Aadhaar eSign documents.
//
// So the anchor is PINNED BY FINGERPRINT here rather than merely being present. Replacing the certificate
// fails this test, and the only way to make it pass is to update the expected SHA-256 deliberately - at
// which point the reviewer has to go and check the new value against what CCA publishes.
//
// Parsing properties (self-signed, CA:TRUE, keyCertSign, in date) are asserted too: a trust anchor that is
// merely well-formed base64 would silently contribute nothing to chain building.
import { describe, expect, it } from "vitest";
import * as pkijs from "pkijs";
import { PROD_ROOT_PEMS, TRUSTED_ROOT_PEMS } from "../web/src/lib/ccaRoots";

// "CCA India 2022", the Root Certifying Authority of India production root, downloaded from
// https://cca.gov.in -> Repository. Verify against CCA's published value before ever changing this.
const CCA_INDIA_2022_SHA256 = "9A:3F:D3:17:67:98:E8:42:DD:CB:12:C2:62:F1:1C:FA:CC:A7:0A:8B:84:C6:EA:6F:DA:30:84:2A:95:A9:4C:D8";
// "CCA India Test 2020", eMudhra's eSign OTP test hierarchy. Trusted only in a dev/sandbox build.
const CCA_INDIA_TEST_2020_SHA256 = "2A:46:51:5C:76:79:83:44:AB:3B:D1:64:B7:49:9F:10:8E:2D:06:A1:52:37:B2:27:79:8A:A8:0E:0A:68:C2:9A";

function parse(pem: string): pkijs.Certificate {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return pkijs.Certificate.fromBER(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

async function sha256(cert: pkijs.Certificate): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", cert.toSchema(true).toBER(false));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

const cn = (name: pkijs.RelativeDistinguishedNames) =>
  name.typesAndValues.find((t) => t.type === "2.5.4.3")?.value.valueBlock.value;

describe("eSign trust store", () => {
  // A production build must anchor on the real CCA root and nothing else. An empty store is fail-closed but
  // useless (everything amber); an extra unexpected root is the dangerous case this pins shut.
  it("trusts exactly the pinned CCA India 2022 root in production", async () => {
    expect(PROD_ROOT_PEMS).toHaveLength(1);
    expect(await sha256(parse(PROD_ROOT_PEMS[0]!))).toBe(CCA_INDIA_2022_SHA256);
  });

  // This suite runs with import.meta.env.DEV set, so the resolved store also carries the sandbox root. What
  // matters is that it carries the production root and NOTHING beyond the two known anchors - an unrecognised
  // fingerprint here means something was added that no one pinned.
  it("resolves to known anchors only", async () => {
    const prints = await Promise.all(TRUSTED_ROOT_PEMS.map((p) => sha256(parse(p))));
    expect(prints).toContain(CCA_INDIA_2022_SHA256);
    expect(prints.filter((p) => p !== CCA_INDIA_2022_SHA256 && p !== CCA_INDIA_TEST_2020_SHA256)).toEqual([]);
  });

  it("is a usable trust anchor: self-signed CA, keyCertSign, in date", async () => {
    const cert = parse(PROD_ROOT_PEMS[0]!);

    expect(cn(cert.subject)).toBe("CCA India 2022");
    expect(cn(cert.issuer)).toBe("CCA India 2022"); // self-signed: a root issues itself

    // basicConstraints CA:TRUE - without it a path builder will not treat this as an issuer at all.
    const basicConstraints = cert.extensions?.find((e) => e.extnID === "2.5.29.19");
    expect(basicConstraints?.parsedValue?.cA).toBe(true);

    // keyUsage bit 5 = keyCertSign. Byte 0x06 = 0b00000110 -> bits 5 (keyCertSign) and 6 (cRLSign).
    const keyUsage = cert.extensions?.find((e) => e.extnID === "2.5.29.15");
    const usageByte = new Uint8Array(keyUsage?.parsedValue?.valueBlock?.valueHexView ?? [])[0];
    expect(usageByte! & 0b00000100).toBeTruthy();

    // Documents are verified as of their signing time, but an anchor already expired today can only ever
    // reject the documents signed from here on.
    expect(cert.notAfter.value.getTime()).toBeGreaterThan(Date.now());

    // Internally consistent: the root's signature checks out against its own key. This proves the bytes are
    // intact, NOT that they are CCA's - only the pinned fingerprint above establishes that.
    if (!pkijs.getCrypto(false)) pkijs.setEngine("test", new pkijs.CryptoEngine({ name: "test", crypto: globalThis.crypto }));
    expect(await cert.verify(cert)).toBe(true);
  });
});
