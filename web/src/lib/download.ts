// THE ONE WAY A FILE REACHES THE DISK from this app.
//
// There were four copies of this - the table export, the .ics download, the asset-tag sticker sheet, and
// api.ts's binary `download()` - and they had already come apart, which is the whole argument for there being
// one. Each of them got two details wrong, and both are the kind that pass in Chrome and fail nowhere you look:
//
//  - REVOKING IN THE SAME TICK AS THE CLICK. `URL.revokeObjectURL(url)` immediately after `a.click()` races the
//    browser's own fetch of the blob URL. Chrome has usually started it by then; Firefox and Safari have not,
//    and the download is cancelled outright - no file, no error, a button that does nothing. The URL is
//    released on a timer instead, long after any browser has taken its copy.
//
//  - NOT ATTACHING THE ANCHOR. Firefox only dispatches a synthetic click on an element that is IN the document.
//    Three of the four copies appended it; `assetTagsPdf.downloadPdf` did not, so the sticker sheet - the one
//    that exists to be printed - was the copy most likely to be broken already.
//
// Nothing else in the app should build an anchor around an object URL. `api.ts#blobUrl` stays separate on
// purpose: it hands a URL to a VIEWER that keeps it open, so its lifetime belongs to the component, not here.

/**
 * How long the object URL is kept alive after the click.
 *
 * Long enough that no browser is still deciding whether to fetch it, short enough that a big export is not
 * pinned in memory for the page's life. The blob is unreachable to anything else once this fires.
 */
const RELEASE_AFTER_MS = 60_000;

/** Save `blob` as `filename` through the browser's own download path. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  // In the document, because Firefox will not act on a click at an element that is not.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // NOT synchronous - see the header. The browser has the URL; it has not necessarily read it yet.
  setTimeout(() => URL.revokeObjectURL(url), RELEASE_AFTER_MS);
}

/** Save raw bytes under a media type - the shape the PDF and calendar producers hand over. */
export function saveBytes(bytes: BlobPart, filename: string, contentType: string): void {
  saveBlob(new Blob([bytes], { type: contentType }), filename);
}
