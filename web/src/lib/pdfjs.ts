// One place to open a PDF. Three components render PDFs (PdfReader, SignedPdfViewer, PdfSignaturePlacer)
// and every one of them needs the same setup, so it lives here instead of being copy-pasted three times.
//
// The setup that matters is the SIDECAR DATA. pdf.js does not bundle the resources it needs to render an
// arbitrary document - it fetches them at runtime from URLs the caller supplies, and every one of those
// options defaults to `null`. Leave them unset and the failures are silent and content-dependent:
//   wasm/             JBIG2 + JPEG2000 image codecs (what office scanners emit) and the qcms colour engine.
//                     The directory also holds pure-JS fallbacks pdf.js uses where wasm cannot run.
//   standard_fonts/   the standard 14 faces (Helvetica, Times, Courier...). A PDF is allowed to reference
//                     these WITHOUT embedding them; absent this, such a document renders with wrong glyphs.
//   cmaps/            character maps for CJK documents.
//   iccs/             the ICC profile used for colour conversion.
// The files are copied out of node_modules into /assets/pdfjs/ at build time (see the `pdfjsData` plugin in
// web/vite.config.ts), so they always match the installed pdfjs-dist and are never vendored into the repo.
//
// Not shipped: wasm/quickjs-eval.*, which is how pdf.js EXECUTES JavaScript embedded in a PDF. That lives
// exclusively in pdf.sandbox.mjs, which this app never imports - it drives the core API directly and never
// the bundled viewer, so document scripting is not reachable. Keeping the payload out is one less way for a
// hostile upload to matter.

const BASE = "/assets/pdfjs";

/** Sidecar-data URLs to spread into every `getDocument()` call. */
export const PDF_DATA_URLS = {
  wasmUrl: `${BASE}/wasm/`,
  standardFontDataUrl: `${BASE}/standard_fonts/`,
  cMapUrl: `${BASE}/cmaps/`,
  cMapPacked: true, // the shipped CMaps are the binary-packed form
  iccUrl: `${BASE}/iccs/`,
} as const;

type Pdfjs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<Pdfjs> | null = null;

/** Load pdf.js (once) with its worker wired up. The module and the worker URL are dynamic imports, so the
 *  ~1.5 MB of PDF machinery stays out of the app bundle until something actually opens a document. */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    return pdfjs;
  })().catch((e) => {
    pdfjsPromise = null; // a failed load (offline mid-chunk) must not poison every later open
    throw e;
  });
  return pdfjsPromise;
}

/** Open a document from a URL or raw bytes, with the sidecar data wired up. */
export async function openPdf(src: string | Uint8Array) {
  const pdfjs = await loadPdfjs();
  const params = typeof src === "string" ? { url: src } : { data: src };
  return pdfjs.getDocument({ ...PDF_DATA_URLS, ...params }).promise;
}
