# Document acknowledgement: choose sign method + visual signature placement

## Context

`/documents` (org-documents) supports one rigid acknowledgement path: `:acknowledge` requires an
on-file signature image, records a legal-name attestation, and generates a **separate certificate
page** appended to the policy PDF (`ackCertificate.ts` → `lib/ackPdf.ts`). The signature never appears
on the document itself, there is no Aadhaar option, and HR can't say where the signature goes.

We want, per acknowledgement-required document, HR to:
1. pick **one** ack method — **internal** digital signature (on-file image) or **Aadhaar e-Sign (Cashfree)**;
2. place the signature by **clicking a fixed-size box** onto the rendered PDF (one box per document, required).

Outcome: the signature lands in-place on the actual document (internal path stamps it; Cashfree path
places it via `sign_positions`), the certificate-page model is dropped, and the existing e-sign
webhook/poll machinery is reused for the per-employee Aadhaar flow.

Decisions (locked with the user): HR picks one method per doc; Aadhaar per-employee is in scope now
(not deferred); one box per doc; drop the certificate page; fixed-size box positioned by click.

## Data model (`src/db/schema.ts`) — one migration, then re-squash

`org_documents`: add
- `ackMethod: text("ack_method", { enum: ["internal", "cashfree"] })` — null unless `requiresAck`.
- `signAnchorJson: text("sign_anchor_json")` — a single box `{ page, x1, y1, x2, y2 }` (PDF points,
  bottom-left origin, 1-based page) — same shape as `EsignSignAnchor` (`src/domain/esign.ts`) and the
  `SignAnchor` the letter renderer already emits (`src/lib/letterPdf.ts:44`). Required when `requiresAck`.

`document_acknowledgements`: 
- rename `certificateDocId` → `signedDocId` (FK → `personalDocuments.uuid`) — now the in-place signed copy.
- add `acknowledgedTime: integer(... "timestamp_ms")` — null = pending (Aadhaar, awaiting signing);
  set = complete. Internal acks set it immediately. `signature` (legal-name attestation) stays.

`personal_documents`: add `ackId: text("ack_id").references(() => documentAcknowledgements.uuid)` —
nullable forward link set on the per-employee Aadhaar copy so `applyEsignEvent` can finalize the ack
when the copy is signed. (Nullable circular FK with `signedDocId` is fine in SQLite/drizzle.)

Regenerate + re-squash to a single migration: `rm -rf src/db/migrations && npx drizzle-kit generate`.

## Backend — `:acknowledge` branches on `ackMethod`

Rework `acknowledge()` in `src/services/documentService.ts:178` (currently generates the certificate).
Precondition unchanged: doc must be a PDF with `requiresAck`. Branch:

**internal** (synchronous, completes now):
1. Guard `emp.signatureKey` (existing check, line 188).
2. Load org PDF `deps.docs.get(row.r2Key)`; stamp the signature into `row.signAnchorJson`'s box with a
   new helper (below); file the result as a personal-document copy (`sourceDocId = org uuid`,
   `documentType: "POLICY"`, `title: "<doc> - signed (v<n>)"`, `docs.put` signed bytes) — reuse the
   direct-insert idiom from `ackCertificate.ts:58-74` (allocOwnedCode, `r2Key = personal-documents/<id>`).
3. Insert ack row: `signature = legalName`, `signedDocId = copy.uuid`, `acknowledgedTime = now`.
   Idempotent per (doc, employee, version) as today.

**cashfree** (asynchronous, completes on webhook) — mirror `src/routes/letterGenerate.ts:76-116`:
1. Resolve signer `{ name, email, aadhaar? }` (Cashfree `requiresAadhaar: false`, last-4 optional).
2. Create the per-employee copy personal-document (`sourceDocId = org uuid`, `requiresSignature: true`,
   `esignProvider: "cashfree"`); `docs.put` the org PDF bytes to the copy's `r2Key`.
3. Insert a **pending** ack row (`acknowledgedTime` null, `signedDocId = copy.uuid`); set `copy.ackId = ack.uuid`.
4. `provider.createRequest({ pdf: orgBytes, fileName, docId: copy.uuid, signers:[signer],
   signAnchors: [anchor], cfg, secrets })` inside a try/catch that unwinds (delete copy + ack) on
   failure. Store `esignProvider/esignRequestId/esignStatus/esignUrl/esignSentAt` on the copy.
5. Return the org doc decorated with `esign_url` (the copy's `signing_link`) so the UI opens the journey.

**Completion hook** — `src/services/esign/callback.ts` `applyEsignEvent` (the single choke point where a
personal-document becomes signed, line 19; covers both webhook and `refreshEsign` poll): after stamping
`signedTime`, `if (row.ackId)` set the linked ack's `acknowledgedTime = now` and `signature = signatureName`.
One lookup + one update; no new matching logic (webhook still resolves by `esignRequestId`).

**New helper** `src/lib/pdfStamp.ts`: `stampSignature(pdfBytes, imageBytes, anchor): Promise<Uint8Array>`
— `PDFDocument.load(buf, { ignoreEncryption: true })` (idiom from `ackCertificate.ts:50`),
`getPages()[anchor.page-1]`, `embedPng`→`embedJpg` fallback + aspect-preserving scale into the box +
`page.drawImage({ x, y, width, height })` (pattern from `letterPdf.ts:294-304`), optional typed-name +
date line under the box. This is the one genuinely new pdf-lib composition (stamping an existing PDF).

**Routes/serialize/openapi** (`src/routes/documentRoutes.ts`, `src/http/serialize.ts`, `openapi.yaml`):
accept + validate `ack_method` + `sign_anchor` on create/patch (required together with `requires_ack`);
expose them on the document resource; decorate the acknowledge response with `esign_url` when pending.

**Removals**: delete `src/services/ackCertificate.ts` and the now-orphaned `src/lib/ackPdf.ts`; drop the
`createAckCertificate` import/call; update the "PDF-only because we append a cert page" rationale comment
(`documentService.ts:163`) — still PDF-only, now because we stamp on it.

## Frontend — `web/`

Add `pdfjs-dist` (lazy `await import("pdfjs-dist")`, auto-chunked like `xlsx` in `exportTable.ts:28`).
Force a same-origin worker to satisfy the SPA CSP (`script-src 'self'`, `worker-src` absent → falls back
to `script-src`): set `GlobalWorkerOptions.workerSrc` from a Vite `?url` import
(`import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`) — emits a hashed same-origin asset,
no `blob:` worker, **no `_headers` CSP change needed**. (Fallback if pdf.js still spawns a blob worker:
add `worker-src 'self'` to `web/public/_headers`.)

New component `web/src/components/common/PdfSignaturePlacer.tsx`: renders PDF pages to a `<canvas>`
(pdf.js), overlays a click-capture layer, draws a **fixed-size** box at the click point, converts the
screen point → PDF points via the page viewport transform, emits `{ page, x1, y1, x2, y2 }`. Page nav
for multi-page docs. PDF source = a local `File` (`URL.createObjectURL(file)`) on create, or fetched
bytes on edit (POST `/v1/<doc.path>:download` → `blob()` → object URL, the pattern in
`LettersTab.tsx:262-270` / `SignatureField.tsx:11-27`; keep the URL, revoke on unmount).

`web/src/pages/Documents.tsx` create/edit dialog: when `form.employee === ORG && form.requireAck`
(PDF-gated, near the checkbox at lines 749-761) show a method radio (internal / Aadhaar) and the
`PdfSignaturePlacer`; block submit until a box is placed. Thread `ack_method` + `sign_anchor` through
`EMPTY` (line 121), `bodyFromForm` (~line 255), and `submit` (line 269) — create/upload order stays
(create doc → `upload(doc.path, file)`); anchor + method go in the create body / an edit `patch`.
In `doAcknowledge` (~line 375): if the response carries `esign_url`, open it (mirror the existing
`esign_url` handling at Documents.tsx:527-532); else it's the internal path, already acknowledged.
Add `ack_method` + `sign_anchor` to `DocumentResource` in `web/src/types.ts:819`.

## Verification

- `npm run verify` (spectral + tsc + vitest) green.
- New service tests (reuse the `test/productionReadiness.test.ts` miniflare harness): (a) internal ack
  stamps the signature onto the org-PDF copy and records the ack `acknowledgedTime`; (b) a signed
  Cashfree webhook (`handleEsignCallback`, valid HMAC) for a copy with `ackId` set flips the linked ack
  to acknowledged and stamps the copy signed — this exercises the completion hook without a live vendor.
- Manual (local stack): create an ack-required PDF doc, pick internal + place the box → acknowledge as an
  employee → downloaded signed copy shows the signature in the chosen box. Repeat with Cashfree
  (sandbox creds) → `:acknowledge` returns a signing link; the poll fallback (`personal-documents:refreshEsign`)
  or webhook finalizes the ack.

## Risks / notes

- Fixed box size: pick a sensible default (~180×54 pt) in `PdfSignaturePlacer`; HR only clicks position.
- Coordinate mapping is the fiddly part — pdf.js viewport is top-left origin at render scale; convert to
  PDF points (bottom-left) so the stored anchor matches pdf-lib + Cashfree. Unit-check the conversion.
- Circular nullable FK (`personal_documents.ackId` ↔ `document_acknowledgements.signedDocId`) is
  intentional and fine; both set post-insert.
- Cashfree `sign_positions` already consume `signAnchors` in the driver — no driver change needed.
