import * as React from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, PenLine } from "lucide-react";
import { blobOf, invoke } from "@/api";
import { navigate } from "@/router";
import { describeError } from "@/lib/formError";
import { cn, idOf } from "@/lib/utils";
import { SignatureImage } from "@/components/common/SignatureField";
import { PdfReader } from "@/components/common/PdfReader";
import { FormError } from "@/components/common/FormError";
import { AccessAction } from "@/components/access/AccessAction";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import type { DocumentResource, Employee } from "@/types";

const isPdfDoc = (d: DocumentResource) => d.content_type === "application/pdf" || /\.pdf$/i.test(d.file_name ?? "");

// Acknowledging a policy and signing your own letter are the same act: read this, then put your name on it.
// They were two hand-rolled dialogs that each told you to "please read" a document you could only reach by
// downloading it - so the one thing the dialog exists to make happen was the one thing it didn't do.
//
// Here the document is rendered in the dialog and the confirm is gated on reaching the end of it and ticking
// "I have read it": the signature is a statement about a document that was actually in front of the signer.
//
// It also walks a queue. Somebody who comes back from three weeks off owes four signatures, and closing and
// reopening a dialog four times is not a flow - so `‹ 2/4 ›` (and `j`/`k`) move through the pending list, and
// signing advances to the next one instead of dropping the reader back on the table.
export function SignDocumentDialog({
  doc,
  mode,
  me,
  queue,
  onSelect,
  onClose,
  onDone,
  onDownload,
}: {
  doc: DocumentResource | null;
  /** `acknowledge` = an org policy's e-sign; `sign` = the owner signing their own generated letter. */
  mode: "acknowledge" | "sign";
  /** The signer's own employee record - its `signature` is what gets embedded. */
  me: Employee | undefined;
  /** Everything else awaiting this same act, in list order, so the dialog can walk it. */
  queue?: DocumentResource[];
  /** Move the dialog to another document in the queue. */
  onSelect?: (d: DocumentResource) => void;
  onClose: () => void;
  onDone: () => void;
  onDownload: (d: DocumentResource) => void;
}) {
  const { toast } = useToast();
  const [read, setRead] = React.useState(false);
  const [atEnd, setAtEnd] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Rendered document bytes, as an object URL for the inline reader. Fetched per opening, revoked on close.
  const [bytes, setBytes] = React.useState<Blob | null>(null);
  const [fetchFailed, setFetchFailed] = React.useState(false);

  const aadhaar = mode === "acknowledge" && doc?.ack_method === "cashfree";
  // Aadhaar signs inside the vendor's journey, so no on-file signature image is needed for that path.
  const needsSignature = !aadhaar;
  const hasSignature = !!me?.signature;
  const name = me ? me.legal_name || `${me.first_name} ${me.last_name}` : "";
  const viewable = !!doc?.size_bytes && !!doc && isPdfDoc(doc);

  // Queue position, and the neighbours to walk to. The current document may itself have dropped out of the
  // queue (it was just signed), so position falls back to "not in the list" rather than jumping around.
  const list = queue ?? [];
  const at = doc ? list.findIndex((d) => d.path === doc.path) : -1;
  const prev = at > 0 ? list[at - 1] : undefined;
  const next = at >= 0 && at < list.length - 1 ? list[at + 1] : undefined;

  React.useEffect(() => {
    setRead(false);
    setAtEnd(false);
    setError(null);
    setFetchFailed(false);
  }, [doc?.path]);

  // Fetch through the normal authorized path (the read is audited like any other).
  React.useEffect(() => {
    if (!doc || !viewable) { setBytes(null); return; }
    let live = true;
    void (async () => {
      try {
        const blob = await blobOf(doc.path);
        if (live) setBytes(blob);
      } catch {
        if (live) setFetchFailed(true);
      }
    })();
    return () => { live = false; setBytes(null); };
  }, [doc, viewable]);

  // j / k walk the queue, like the board and ticket dialogs - but never while a decision is in flight.
  React.useEffect(() => {
    if (!doc || list.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "j" && next) { e.preventDefault(); onSelect?.(next); }
      if (e.key === "k" && prev) { e.preventDefault(); onSelect?.(prev); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, list.length, next, prev, onSelect, busy]);

  async function confirm() {
    if (!doc) return;
    setBusy(true);
    setError(null);
    // Captured before the write: `onDone` reloads, which rewrites the queue this document is leaving.
    const after = next ?? list.find((d) => d.path !== doc.path);
    try {
      const res = await invoke<DocumentResource>(doc.path, mode === "acknowledge" ? "acknowledge" : "sign");
      if (res.esign_uri) {
        // Aadhaar (Cashfree): the ack stays pending until the employee finishes the vendor journey.
        window.open(res.esign_uri, "_blank", "noopener");
        toast({ title: "Complete your Aadhaar e-sign", description: "Finish signing in the new tab; this document updates once done.", variant: "success" });
      } else {
        toast({ title: mode === "acknowledge" ? "Acknowledged" : "Signed", description: doc.display_name, variant: "success" });
      }
      onDone();
      // Straight on to the next one in the queue; only the last signature closes the dialog.
      if (after && onSelect) onSelect(after);
      else onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Still fetching: a viewable document that has neither arrived nor failed. The gate stays SHUT across that
  // window rather than opening until the bytes land - `bytes` is what turns scrolling into a requirement, so
  // keying `mustScroll` off its arrival leaves the checkbox and Confirm live for the beat before the document
  // is even on screen, and a policy signed there was signed without ever having been shown.
  const loadingDoc = viewable && !bytes && !fetchFailed;
  const mustScroll = viewable && !fetchFailed && !atEnd;
  const canConfirm = read && !mustScroll && (!needsSignature || hasSignature);
  const whyNot = loadingDoc
    ? "Wait for the document to load."
    : mustScroll
      ? "Scroll to the end of the document first."
      : !read
        ? "Confirm you've read the document."
        : "A signature on file is required.";

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent scrollBody className={viewable ? "sm:max-w-3xl" : undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{mode === "acknowledge" ? "Acknowledge document" : "Sign document"}</span>
            {list.length > 1 && at >= 0 && (
              <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 coarse:h-9 coarse:w-9" disabled={!prev || busy} onClick={() => prev && onSelect?.(prev)} aria-label="Previous document (k)">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="tabular-nums">{at + 1}/{list.length}</span>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 coarse:h-9 coarse:w-9" disabled={!next || busy} onClick={() => next && onSelect?.(next)} aria-label="Next document (j)">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {mode === "acknowledge"
              ? aadhaar
                ? "You sign with Aadhaar (OTP) on a secure page; a signed copy is filed under your documents once it completes."
                : "Your signature is stamped onto a copy of this document and filed under your documents. HR sees your name and the time you signed."
              : "Your signature on file is placed on the document and it locks - nobody can change it afterwards."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FormError error={error} />
          {doc && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">
                  {doc.display_name}
                  {mode === "acknowledge" && doc.ack_version ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">version {doc.ack_version}</span> : null}
                </p>
                {doc.size_bytes ? (
                  // Saving a copy is the document's own `download` verb - a separate grant from reading it in
                  // here, so the offer follows the row's hint.
                  <AccessAction collection={doc.path.split("/")[0]} objectPath={doc.path} can={doc.access?.can} verb="download" label="Download">
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onDownload(doc)}>
                      <Download className="mr-1 h-3.5 w-3.5" /> Download
                    </Button>
                  </AccessAction>
                ) : null}
              </div>

              {viewable && !fetchFailed ? (
                bytes ? (
                  <PdfReader src={bytes} className="h-[48dvh]" onReachedEnd={() => setAtEnd(true)} />
                ) : (
                  <p className="flex h-[48dvh] items-center justify-center gap-2 rounded-md border bg-muted/30 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Opening the document…
                  </p>
                )
              ) : (
                <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  {!doc.size_bytes
                    ? "No file is attached to this document."
                    : fetchFailed
                      ? "The document couldn't be shown here - download it to read it before signing."
                      : "This file can't be shown inline - download it to read it before signing."}
                </p>
              )}

              <label className={cn("flex items-start gap-2 rounded-lg border p-3", mustScroll && "opacity-60")}>
                <Checkbox checked={read} disabled={mustScroll} onCheckedChange={(v) => setRead(v === true)} className="mt-0.5" />
                <span className="text-sm">
                  I have read {mode === "acknowledge" ? "this document" : "this letter"} and agree to sign it{mode === "acknowledge" && doc.ack_version ? ` (version ${doc.ack_version})` : ""}.
                  {mustScroll && <span className="block text-xs text-muted-foreground">{loadingDoc ? "Available once the document has loaded." : "Available once you reach the last page."}</span>}
                </span>
              </label>

              {needsSignature && (hasSignature ? (
                <div className="rounded-lg border bg-white p-3 dark:bg-brand-neutral-100">
                  <p className="mb-1 text-xs text-muted-foreground dark:text-brand-neutral-500">
                    Signing as <span className="font-medium text-foreground dark:text-brand-neutral-900">{name}</span>
                  </p>
                  <SignatureImage employeeId={me ? idOf(me.path) : ""} signature={me!.signature} className="max-h-16 object-contain" />
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="space-y-1.5">
                    <p>A signature on file is required{mode === "acknowledge" ? " to acknowledge documents" : " to sign documents"}.</p>
                    <Button variant="outline" size="sm" onClick={() => { onClose(); navigate("profile"); }}>Add your signature</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter className="sm:items-center sm:justify-end">
          {!canConfirm && <p className="text-xs text-muted-foreground sm:mr-1 sm:max-w-[20rem] sm:text-right">{whyNot}</p>}
          <Button variant="outline" onClick={onClose}>{list.length > 1 ? "Close" : "Cancel"}</Button>
          <Button onClick={confirm} loading={busy} disabled={!canConfirm}>
            {aadhaar
              ? <><ExternalLink className="h-4 w-4" /> Continue to Aadhaar e-Sign</>
              : <><PenLine className="h-4 w-4" /> {mode === "acknowledge" ? "Acknowledge" : "Sign"}{next ? " & next" : ""}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
