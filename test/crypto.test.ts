import { describe, it, expect } from "vitest";
import { makeEncryptor } from "../src/lib/crypto";

// A fixed 32-byte (base64) test key. Generate real keys with crypto.randomBytes(32).
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("field encryption", () => {
  it("round-trips and ciphertext != plaintext", async () => {
    const enc = makeEncryptor(KEY);
    const secret = "IBAN GB29 NWBK 6016 1331 9268 19";
    const blob = await enc.encrypt(secret);
    expect(blob).not.toEqual(secret);
    expect(await enc.decrypt(blob)).toEqual(secret);
  });

  it("byte payloads round-trip and the sealed bytes differ from plaintext", async () => {
    const enc = makeEncryptor(KEY);
    const file = crypto.getRandomValues(new Uint8Array(4096));
    const sealed = await enc.encryptBytes(file);
    expect(sealed.byteLength).toBe(file.byteLength + 12 + 16); // IV + GCM tag
    expect(Buffer.from(sealed)).not.toEqual(Buffer.from(file));
    const back = await enc.decryptBytes(sealed);
    expect(Buffer.from(back)).toEqual(Buffer.from(file));
  });

  it("empty byte payload round-trips", async () => {
    const enc = makeEncryptor(KEY);
    const back = await enc.decryptBytes(await enc.encryptBytes(new Uint8Array(0)));
    expect(back.byteLength).toBe(0);
  });
});
