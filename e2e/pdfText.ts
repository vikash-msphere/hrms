// Reading a generated PDF's own text, for the handful of things a byte-signature check ("%PDF-") cannot
// prove: a caption that names the wrong year, a total that doesn't match, a block that silently didn't
// render. Nothing in the suite did this before - every existing PDF check stops at "it is a PDF, and the
// right number of pages/bytes came back". pdfjs-dist is already a server dependency (letter/payslip
// rendering); this just runs its legacy Node build directly, no browser involved.
import path from "node:path";
import { fileURLToPath } from "node:url";

let workerSrc: string | undefined;

/** Every line of text on one page of a PDF, in the order pdfjs lays them out. */
export async function extractPdfPageText(bytes: Uint8Array | Buffer, pageNumber = 1): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  workerSrc ??= path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
}

/** All of a PDF's text, pages joined with a blank line. */
export async function extractPdfText(bytes: Uint8Array | Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  workerSrc ??= path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return pages.join("\n\n");
}
