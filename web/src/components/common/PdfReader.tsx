import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { openPdf } from "@/lib/pdfjs";

// A PDF you can actually read, inside a dialog.
//
// An <iframe> hands the file to whatever viewer the browser feels like: a toolbar on desktop, a download
// prompt on some mobile browsers, and no way for the page to know whether anybody scrolled. That last part
// matters here - the acknowledgement flow wants to say "I have read it" about a document that was in front of
// the reader, so it needs the end of the document to be an observable event.
//
// So: pdf.js (lazy-imported, same worker setup as the signature placer), every page rendered to its own canvas
// in one scrolling column, and `onReachedEnd` fired when the last page comes into view - including the case
// where the whole thing fits without scrolling at all.
export function PdfReader({
  src,
  className,
  onReachedEnd,
}: {
  src: File | Blob | string;
  className?: string;
  /** Fired once when the bottom of the document has been seen. */
  onReachedEnd?: () => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [doc, setDoc] = React.useState<{ pdf: any; pages: number } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const reachedRef = React.useRef(false);
  const endRef = React.useRef(onReachedEnd);
  endRef.current = onReachedEnd;

  React.useEffect(() => {
    let cancelled = false;
    let loaded: any = null;
    reachedRef.current = false;
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        loaded = await openPdf(typeof src === "string" ? src : new Uint8Array(await src.arrayBuffer()));
        if (cancelled) { loaded.destroy?.(); return; }
        setDoc({ pdf: loaded, pages: loaded.numPages });
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "couldn't render the PDF");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; loaded?.destroy?.(); };
  }, [src]);

  const markRead = React.useCallback(() => {
    if (reachedRef.current) return;
    reachedRef.current = true;
    endRef.current?.();
  }, []);

  // A one-page policy that fits the viewport was still "read to the end" - otherwise the tick-box would be
  // impossible to satisfy on exactly the documents that are shortest.
  //
  // Measured only once the reader HAS a size, and again after the browser has laid the canvas out. A box
  // that is still being laid out - a dialog mid-animation, a canvas whose height has not been applied yet -
  // reports scrollHeight === clientHeight, and that is not "the whole document is on screen": it is "there
  // is nothing on screen yet". Treating the two the same let an unread policy unlock its own consent gate,
  // which is the one thing this reader exists to prevent.
  const checkFits = React.useCallback(() => {
    const measure = () => {
      const el = scrollRef.current;
      if (!el || el.clientHeight <= 0 || el.scrollHeight <= 0) return;
      if (el.scrollHeight - el.clientHeight <= 8) markRead();
    };
    requestAnimationFrame(() => requestAnimationFrame(measure));
  }, [markRead]);

  // And re-measured whenever the reader's box changes: a document that only fits AFTER the dialog settles
  // (or after the window is resized) is still one nobody has to scroll, and its tick-box has to be reachable.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc) return;
    const ro = new ResizeObserver(() => checkFits());
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc, checkFits]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) markRead();
    // Which page is under the top of the viewport, for the "3 / 8" readout.
    const canvases = Array.from(el.querySelectorAll<HTMLElement>("[data-page]"));
    const top = el.scrollTop + 8;
    let current = 1;
    for (const c of canvases) if (c.offsetTop <= top) current = Number(c.dataset.page ?? 1);
    setPage(current);
  }

  return (
    <div className={cn("relative flex min-h-0 flex-col overflow-hidden rounded-md border bg-muted/30", className)}>
      {loading && (
        <p className="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening the document…
        </p>
      )}
      {error && <p className="p-6 text-sm text-destructive">Couldn't render the PDF: {error}</p>}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto p-2">
        {doc && Array.from({ length: doc.pages }, (_, i) => (
          <PdfPage key={i} pdf={doc.pdf} page={i + 1} onRendered={i + 1 === doc.pages ? checkFits : undefined} />
        ))}
      </div>
      {doc && doc.pages > 1 && (
        <div className="pointer-events-none absolute bottom-2 right-3 rounded-full bg-foreground/75 px-2 py-0.5 text-xs font-medium tabular-nums text-background">
          {page} / {doc.pages}
        </div>
      )}
    </div>
  );
}

// One page, rendered at the container's width. Each page owns its own canvas so the column scrolls like a
// document rather than paging like a slideshow.
function PdfPage({ pdf, page, onRendered }: { pdf: any; page: number; onRendered?: () => void }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const doneRef = React.useRef(onRendered);
  doneRef.current = onRendered;

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) return;
      const canvas = ref.current;
      if (!canvas) return;
      const containerW = (canvas.parentElement?.clientWidth ?? 600) - 8;
      const base = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: Math.min(containerW / base.width, 2) });
      canvas.width = vp.width;
      canvas.height = vp.height;
      await p.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      if (!cancelled) doneRef.current?.();
    })();
    return () => { cancelled = true; };
  }, [pdf, page]);

  return <canvas ref={ref} data-page={page} className="mx-auto mb-2 block max-w-full rounded bg-white shadow-sm" />;
}
