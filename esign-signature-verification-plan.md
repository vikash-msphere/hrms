# e-Sign signature-validity stamp — production plan

Client-side verification + display of the embedded digital signature in Cashfree/eMudhra
Aadhaar-eSigned PDFs. Renders the universal valid / invalid / unknown stamp (green tick /
red cross / amber ?) inside the app, the same way Adobe/eMudhra viewers do — **without
modifying the stored PDF and without any server-side work**.

## Status

**Implemented and verified against a real eMudhra ECDSA-signed sample.** What remains is
production trust configuration, automated tests, and repo hygiene (below).

## How it works (the mechanism)

The green/red/amber icon is NOT painted by anyone — the PDF viewer renders it by verifying
the embedded PKCS#7 / PAdES signature and checking the signer certificate chains to a
trusted CA root. Cashfree Aadhaar eSign returns a PDF that already carries the embedded
eMudhra/CCA certificate, so Adobe shows the tick natively on download. We reproduce that
verification **in the browser** and draw the stamp as a DOM overlay over the signature
widget. The stored file is never touched; nothing runs on the server.

- **valid (green)** — signature intact (bytes unaltered) + signature authentic + signer
  cert chains to a trusted root.
- **invalid (red)** — digest/signature check fails (document altered after signing).
- **unknown (amber)** — intact + authentic, but the cert does not chain to a bundled
  trusted root (e.g. a sandbox-signed doc in a production build). The honest fallback.

## Code map

| File | Role |
|---|---|
| `web/src/lib/pdfSignature.ts` | Browser verifier. Extracts `/ByteRange`+`/Contents`, verifies digest+signature (PKI.js/WebCrypto), chains to trusted roots **as of signing time**, extracts signer CN / serial / signing time / reason / location. |
| `web/src/lib/ccaRoots.ts` | Trusted **root** anchors. Two tiers: `PROD_ROOT_PEMS` and sandbox roots gated by `allowSandbox()`. |
| `web/src/components/common/SignedPdfViewer.tsx` | pdf.js viewer; draws the stamp as a DOM overlay at the signature widget rect (from `getAnnotations()`). Lazy-loaded. |
| `web/src/pages/Documents.tsx` | "View signature" row action → dialog → `SignedPdfViewer`; bytes fetched via existing `POST /v1/<path>:download`. |

Dependencies added: `pkijs`, `asn1js`, `pvutils` (WebCrypto-based). **Not** node-forge —
it cannot parse or verify ECDSA, which modern eMudhra eSign certs use.

## Hard-won technical facts (do not regress)

1. **eSign certs are ECDSA** (`1.2.840.10045.2.1`). node-forge throws `OID is not RSA`.
   PKI.js + WebCrypto handles ECDSA and RSA. Keep PKI.js.
2. **Verify the chain AS OF the signing time**, not "now". eSign leaf certs are valid for
   ~30 minutes (sample: `20:23:27 → 20:53:27`); validating at "now" wrongly rejects.
   `CertificateChainValidationEngine({ verificationTime: signingTime })`.
3. **`trustedCerts` = ROOTS ONLY.** Putting an intermediate in the trusted set breaks
   PKI.js path-building. Intermediates are embedded in the eSign PDF's CMS already.
4. **Do not augment the cert pool.** Adding duplicate intermediate copies to `certs` also
   breaks path-building. Pass `certs: sd.certificates` (embedded) unchanged.
5. **`/Contents` is zero-padded** — parse DER with `parseAllBytes: false` (BER stops at the
   SEQUENCE end).
6. **eMudhra runs separate TEST and PRODUCTION hierarchies.** A sandbox-signed doc must not
   verify green under production roots.

## Production deployment

1. **Obtain the production CCA root(s).** From https://cca.gov.in (Repository → CA
   certificates): the current CCA India production root (e.g. "CCA India 2022"). If eSign
   docs may come from multiple CCA-licensed CAs ((n)Code, NSDL e-Gov, etc.), collect each
   relevant **root**. Verify each fingerprint out-of-band before trusting.
2. **Add them to `PROD_ROOT_PEMS`** in `web/src/lib/ccaRoots.ts` (full PEM blocks, roots
   only — never intermediates).
3. **Sandbox gate stays off in prod.** `allowSandbox()` is true only when
   `import.meta.env.DEV` or `VITE_ESIGN_ALLOW_SANDBOX=true`. A normal `npm run build:web`
   trusts prod roots only. For a sandbox-pointed staging deploy, set
   `VITE_ESIGN_ALLOW_SANDBOX=true` at build time.
4. **Root rollover:** CCA/CA roots expire and roll. Keep `PROD_ROOT_PEMS` current; when a
   CA issues a new root, add it (keep the old until all docs under it age out).
5. **No server / API / schema changes.** The stored signed PDF stays byte-identical; the
   feature is entirely client-side. Nothing to migrate or deploy server-side.
6. **Bundle note:** PKI.js + asn1js + the viewer are isolated in the lazy `SignedPdfViewer`
   chunk (~398 kB / ~88 kB gz), loaded only when a signature is viewed. pdf.js is its own
   chunk. Main and Documents bundles are unaffected.

## Validation (post-deploy smoke)

- **Real production doc → green.** Open a genuine Cashfree Aadhaar-eSigned document via
  "View signature"; expect green "Signature valid" + correct signer name + signing time.
  Cross-check: the same file opened in Adobe shows the same validity.
- **Tamper → red.** Flip one byte of a signed PDF; expect red "Signature invalid".
- **Untrusted → amber.** A sandbox-signed doc (or one from an un-bundled CA) in a prod
  build shows amber "Validity unknown".
- **Unsigned → no stamp.** A plain PDF shows "No digital signature found".
- **Integrity of the original:** download the doc after viewing; confirm it is
  byte-identical to what was stored (the viewer never rewrites it).

## Testing (to build)

Web currently has **no** browser/jsdom test harness (root `vitest.config.ts` is the
Cloudflare Workers pool for server tests). To add automated coverage:

1. Add a web Vitest config (jsdom env + the `@/` path alias) OR a Node-based test that
   imports `verifyPdfSignatures` (it depends only on PKI.js + WebCrypto, both available in
   Node ≥ 20 via `globalThis.crypto`).
2. **Fixtures** (`web/test/fixtures/`): a real eSign-signed sample PDF + the matching test
   root PEM. Available now: `signed.pdf` (eMudhra sandbox, signer "VIKASH SUROLIA") and
   `3.pem` (CCA India Test 2020).
3. **Cases:**
   - signed sample + test root trusted → `valid`, signer/serial/signingTime extracted.
   - same bytes, one byte flipped → `invalid`.
   - signed sample, no roots bundled → `unknown`.
   - unsigned PDF → `[]` (no signature).
   - assert chain is validated at signing time (a leaf expired-by-now still `valid`).
4. Keep the sandbox gate covered: with `allowSandbox()` false, the sample → `unknown`.

## Open items / follow-ups

- [ ] Obtain + bundle the **production CCA root(s)** (blocks green for live docs).
- [ ] Decide **repo hygiene** for the loose files in project root (`signed.pdf`, `1.pem`,
      `2.pem`, `3.pem`, `emudhra-sub-ca-for-esign-otp-2014.crt`). Recommended: move
      `signed.pdf` + `3.pem` into `web/test/fixtures/` for the test above; gitignore or
      delete the rest (`3.pem` is already inlined in `ccaRoots.ts`).
- [ ] Multi-signer PDFs: results are correlated to signature widgets in document order
      (exact for the common single-signer case). If multi-signer becomes real, correlate
      by field name instead of index.
- [ ] Non-P-256/384/521 curves: WebCrypto only supports those ECDSA curves; an exotic-curve
      signer would show amber. Not expected for Indian eSign, but note it.
- [ ] Optional: surface the verified validity back onto the Documents list badge (currently
      the authoritative stamp lives in the viewer).

## Production auth: X-Cf-Signature (2FA) — DONE

Cashfree production accounts require the `x-cf-signature` header on every verification API
call. **The scheme is RSA-OAEP(SHA-1) *encryption* of `clientId.<unix-seconds>` with
Cashfree's public key, base64'd — NOT a private-key signature** (mirrors their PHP
`openssl_public_encrypt` + `OPENSSL_PKCS1_OAEP_PADDING`, default SHA-1). Cashfree decrypts
with its private key and checks the clientId + timestamp freshness. Verified roundtrip with
WebCrypto.

Wired in:
- `src/env.ts` — `ESIGN_CASHFREE_PUBLIC_KEY` (base64 SPKI or PEM; absent ⇒ header not sent).
- `src/domain/esign.ts` — `EsignSecrets.publicKey`.
- `src/deps.ts` — maps the env var into `esignSecrets.cashfree.publicKey`.
- `src/services/esign/cashfree.ts` — `cfSignature()` + async `authHeaders()` adds
  `x-cf-signature` to all four calls (upload, create, getStatus, signed-doc download) when a
  public key is present. Sandbox/secret-only accounts (no key) are unaffected. The imported
  `CryptoKey` is cached; the signature itself is regenerated per request (OAEP is randomized).

Deploy steps:
1. Generate/copy Cashfree's public key from the Secure ID dashboard (public-key 2FA mode).
2. Set the `ESIGN_CASHFREE_PUBLIC_KEY` secret in the prod worker (`wrangler secret put`).
3. Ensure the host clock is NTP-synced — Cashfree rejects timestamps >5 min off.
4. If the stored key is PEM, that's fine (the loader strips the armor); base64 SPKI also works.

## Related (separate, already done this branch)

Server-side Cashfree e-Sign hardening — scheduled poll reconcile + auto-expire, webhook
replay/staleness guard, upload size/format pre-check, `expiry_in_days` floor. See
`src/services/esign/*`, `src/cron.ts`, tests in `test/esign.test.ts` +
`test/documentAck.test.ts`.
