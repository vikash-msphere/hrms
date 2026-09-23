// Wire-id codec: the internal PK is a compact 8-byte random id (never on the wire). The wire token is
// a deterministic authenticated encryption of it, so it is opaque, non-enumerable, tamper-evident, and
// bound to its collection - and crucially it is pure COMPUTE (no DB lookup) in both directions.
//
// Construction (a miniaturized SIV; AES-SIV's idea at a smaller size, justified by our parameters):
//   tag      = HMAC-SHA256(macKey, collection || 0x1f || idBytes)[:8]    // synthetic IV + integrity
//   counter  = tag(8) || 0x00*8                                          // AES-CTR initial block
//   ct       = AES-CTR(encKey, counter, idBytes)                         // 8 bytes
//   token    = base32(tag || ct)                                         // 16 bytes -> 26 chars
// decode reverses it and recomputes the tag from the recovered id; a wrong key, a tampered token, or a
// token presented under another collection fails the tag check -> null (fail-closed, zero DB reads).
//
// Why a 64-bit synthetic IV/tag is fine here (vs RFC 5297's 128-bit): ids are few and unique, so the
// tag (a function of a unique id) is unique with overwhelming probability -> no CTR keystream reuse
// (collision birthday-bounds at ~2^32 ids); forgery resistance is 2^-64, ample for an internal app.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32 (matches codes.ts)
const REV = (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET.charCodeAt(i)] = i;
  return m;
})();

export function bytesToBase32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32ToBytes(s: string, byteLen: number): Uint8Array<ArrayBuffer> | null {
  const out = new Uint8Array(byteLen);
  let bits = 0;
  let value = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? (REV[c] ?? -1) : -1;
    if (v < 0) return null; // illegal char
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (n >= byteLen) return null; // too long
      out[n++] = (value >>> bits) & 0xff;
    }
  }
  if (n !== byteLen) return null;
  // CANONICAL ONLY. base32 carries 5 bits per character, so a byte count whose bit length is not a multiple of
  // 5 leaves a remainder in the final character: 16 bytes is 128 bits spread over 26 characters = 130, so 2
  // bits of the last character are not part of the value (an 8-byte id over 13 characters leaves 1). `encode`
  // always emits them as zero, but decoding discarded them unread - so four different strings decoded to the
  // same 16-byte token, and all four were accepted. The tag still authenticated the recovered id, so this was
  // never a forgery route; what it did mean is that one row had four valid spellings on the wire, which breaks
  // anything treating the token as an identity: a cache key, an idempotency key, a log grep, or simply
  // comparing two references to the same record for equality. Rejecting a non-zero remainder makes the
  // encoding a bijection, so a token has exactly one spelling.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/**
 * Is `s` an internal id this codec can round-trip: 13 characters of the alphabet that decode CANONICALLY to 8
 * bytes (the 65th bit zero)?
 *
 * The regex alone is not the question. A 13-character string whose last character carries the spare bit
 * passes `[0-9a-hj-km-np-tv-z]{13}` and then makes `encode` throw - so every place that is handed an id it did
 * not mint (a caller-chosen `?id=`, a string in a response body that merely LOOKS like a ref) asks this.
 */
export function isInternalId(s: unknown): s is string {
  return typeof s === "string" && s.length === 13 && base32ToBytes(s, 8) !== null;
}

// A new internal id: 8 random bytes -> 13-char base32 string (the PK / FK value, internal only).
export function genId(): string {
  return bytesToBase32(crypto.getRandomValues(new Uint8Array(8)));
}

const te = new TextEncoder();
function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export type IdCodec = {
  encode(collection: string, id: string): Promise<string>;
  decode(collection: string, token: string): Promise<string | null>;
};

// ONE codec per key per isolate.
//
// `makeIdCodec` memoizes its derived subkeys on the INSTANCE, so a fresh instance re-derives them - two HKDF
// deriveBits plus two importKey - on its first use. `makeDeps` builds a Deps per request (middleware/
// dbContext.ts), so every request was paying that derivation again the moment the outbound edge encoded its
// first id, which is essentially every response. src/index.ts already memoized a codec for the inbound edge
// and said so; that memo simply never reached `deps.idCodec`, which is the one nearly all the work goes
// through. Keying the memo on the key material rather than parking it in index.ts keeps deps.ts free of an
// import cycle and means both edges land on the same instance by construction.
//
// The map is keyed by the base64 key, so a test that swaps WIRE_ID_KEY gets its own codec rather than a
// stale one, and `makeIdCodec` stays available for a caller that genuinely wants an unshared instance.
const CODECS = new Map<string, IdCodec>();
export function codecFor(keyBase64: string): IdCodec {
  let c = CODECS.get(keyBase64);
  if (!c) CODECS.set(keyBase64, (c = makeIdCodec(keyBase64)));
  return c;
}

export function makeIdCodec(keyBase64: string): IdCodec {
  const keyBytes = new Uint8Array(Buffer.from(keyBase64, "base64"));
  // Derive independent enc/mac subkeys from the master via HKDF; memoize the imported keys.
  let keysP: Promise<{ encKey: CryptoKey; macKey: CryptoKey }> | null = null;
  const keys = () =>
    (keysP ??= (async () => {
      const base = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
      const salt = new Uint8Array(0);
      const enc = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("wireid-enc") }, base, 128);
      const mac = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("wireid-mac") }, base, 256);
      const encKey = await crypto.subtle.importKey("raw", enc, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
      const macKey = await crypto.subtle.importKey("raw", mac, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return { encKey, macKey };
    })());

  const tagOf = async (macKey: CryptoKey, collection: string, idBytes: Uint8Array) => {
    const aad = te.encode(collection);
    const msg = new Uint8Array(aad.length + 1 + idBytes.length);
    msg.set(aad, 0);
    msg[aad.length] = 0x1f; // separator so (collection,id) is unambiguous
    msg.set(idBytes, aad.length + 1);
    const full = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, msg));
    return full.slice(0, 8);
  };
  const counterOf = (tag: Uint8Array) => {
    const c = new Uint8Array(16);
    c.set(tag, 0); // [tag(8) | zeros(8)] - deterministic per id, no reuse
    return c;
  };

  return {
    async encode(collection, id) {
      const idBytes = base32ToBytes(id, 8);
      if (!idBytes) throw new Error("idCodec.encode: id is not an 8-byte base32 string");
      const { encKey, macKey } = await keys();
      const tag = await tagOf(macKey, collection, idBytes);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: counterOf(tag), length: 64 }, encKey, idBytes));
      const token = new Uint8Array(16);
      token.set(tag, 0);
      token.set(ct, 8);
      return bytesToBase32(token);
    },
    async decode(collection, token) {
      const bytes = base32ToBytes(token, 16);
      if (!bytes) return null; // wrong length / illegal char
      const tag = bytes.slice(0, 8);
      const ct = bytes.slice(8);
      const { encKey, macKey } = await keys();
      const idBytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: counterOf(tag), length: 64 }, encKey, ct));
      const expect = await tagOf(macKey, collection, idBytes);
      if (!ctEqual(expect, tag)) return null; // forged / tampered / wrong collection
      return bytesToBase32(idBytes);
    },
  };
}
