// Reading a generated PDF's own text, for the handful of things a byte-signature check ("%PDF-") cannot
// prove: a caption that names the wrong year, a total that doesn't match, a block that silently didn't
// render. Nothing in the suite did this before - every existing PDF check stops at "it is a PDF, and the
// right number of pages/bytes came back". pdfjs-dist is already a server dependency (letter/payslip
// rendering); this just runs its legacy Node build directly, no browser involved.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "../node_modules/pdfjs-dist");

// The SIDECAR DATA, for the same reason web/src/lib/pdfjs.ts spells it out for the browser: pdf.js does not
// bundle the resources it needs to read an arbitrary document, it loads them at runtime from a location the
// caller supplies, and every one of these options defaults to `null`.
//
// `standardFontDataUrl` is the one this suite actually needs. A PDF is allowed to REFERENCE the standard 14
// faces (Helvetica, Times, Courier) without embedding them, which is exactly what the letter and payslip
// engines produce, so without it every read of one logs
//   Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.
// and falls back to guessed glyph widths. The others are here so a document that needs them (a CJK letter, a
// scanned attachment) reads the same as it would in the app rather than becoming the next silent surprise.
//
// Filesystem paths, not URLs: pdf.js's Node factories read these with `node:fs`, and each MUST end in a
// separator or the last segment is treated as a filename prefix.
const DATA = {
  standardFontDataUrl: path.join(DIST, "standard_fonts") + path.sep,
  cMapUrl: path.join(DIST, "cmaps") + path.sep,
  cMapPacked: true, // the shipped CMaps are the binary-packed form
  iccUrl: path.join(DIST, "iccs") + path.sep,
  wasmUrl: path.join(DIST, "wasm") + path.sep,
} as const;

/** The document, opened with the worker and the sidecar data both wired up. One place, so a reader added
 *  later cannot quietly go without them. */
async function open(bytes: Uint8Array | Buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(DIST, "legacy/build/pdf.worker.mjs");
  return pdfjs.getDocument({ data: new Uint8Array(bytes), ...DATA }).promise;
}

/** The text of one page, in the order pdfjs lays it out. */
const pageText = async (doc: Awaited<ReturnType<typeof open>>, pageNumber: number): Promise<string> => {
  const content = await (await doc.getPage(pageNumber)).getTextContent();
  return content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
};

/** Every line of text on one page of a PDF, in the order pdfjs lays them out. */
export async function extractPdfPageText(bytes: Uint8Array | Buffer, pageNumber = 1): Promise<string> {
  return pageText(await open(bytes), pageNumber);
}

/** All of a PDF's text, pages joined with a blank line. */
export async function extractPdfText(bytes: Uint8Array | Buffer): Promise<string> {
  const doc = await open(bytes);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await pageText(doc, i));
  return pages.join("\n\n");
}
