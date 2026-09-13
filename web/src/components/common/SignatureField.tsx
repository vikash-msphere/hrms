import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, PenLine } from "lucide-react";
import { api, dataUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AccessTarget } from "@/components/access/AccessTarget";
import { useToast } from "@/components/ui/use-toast";

// Fetch a signature image as a data URL. `signature` is the resource marker (employees/<id>:getSignature) and
// `version` lets a parent force a refetch after upload/remove (the marker string is stable).
//
// THROUGH THE API CLIENT, not a hand-rolled fetch. Two things rode on that and both were missing here: the
// request carried no `X-View-As`, so during an access-mode simulation this answered as the REAL admin and
// rendered a signature the simulated person is owner-gated out of - on the one screen whose whole job is to
// show what they see; and a 401 never reached the session-expired handoff, so the image just stayed blank.
//
// `dataUrl` rather than `blobUrl` for the reason api.ts gives: an object URL has to be revoked by hand, and
// this hook re-fetches on `version` - so the cleanup of the previous run raced the new one and revoked the URL
// the <img> was still displaying. A data URL stays valid for as long as it is held; nothing to get wrong.
function useSignatureUrl(employeeId: string, signature?: string, version = 0) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!signature) {
      setSrc(null);
      return;
    }
    dataUrl(`employees/${employeeId}`, { verb: "getSignature" })
      .then((url) => { if (active) setSrc(url); })
      .catch(() => { if (active) setSrc(null); });
    return () => { active = false; };
  }, [employeeId, signature, version]);
  return src;
}

// Read-only signature image (used in the acknowledge dialog + HR acknowledgement view). Renders nothing when
// the employee has no signature on file.
export function SignatureImage({ employeeId, signature, className }: { employeeId: string; signature?: string; className?: string }) {
  const src = useSignatureUrl(employeeId, signature);
  if (!signature || !src) return null;
  // BLOCKED, not masked: masking is a text operation and would not touch an image, and this `src` is a data:
  // URL, so the signature's own bytes are serialised into the replay rather than a link needing a session to
  // fetch. A clean PNG of somebody's signature is the whole input to forging the letters this app e-signs
  // with it, and "Report a problem" attaches the current replay to a helpdesk ticket. A blocked image leaves a
  // placeholder box, which is all a replay needs from it.
  return <img src={src} alt="Signature" data-sentry-block className={className ?? "h-12 object-contain"} />;
}

const ACCEPT = "image/png,image/jpeg";
const MAX_BYTES = 3 * 1024 * 1024;

// Editable signature panel for a profile: shows the current signature on a white sheet, with upload/replace +
// remove. Upload/remove are gated by the caller (canEdit) and the server (self/HR via the employees path).
export function SignatureField({ employeeId, signature, canEdit, onChanged }: { employeeId: string; signature?: string; canEdit?: boolean; onChanged?: () => void }) {
  const { toast } = useToast();
  const [version, setVersion] = useState(0);
  // Removal is known here before the parent's reload lands, and the marker it carries is stale from that
  // moment on. Refetching against it asks storage for a file that has just been deleted - a 404 the browser
  // logs as a failed request - so the panel stops asking rather than asking and ignoring the answer. Reset
  // whenever the parent hands down a new marker (the reload that follows, or an upload after this).
  const [removed, setRemoved] = useState(false);
  useEffect(() => setRemoved(false), [signature]);
  const src = useSignatureUrl(employeeId, removed ? undefined : signature, version);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPick(file: File | null) {
    if (!file) return;
    if (!ACCEPT.split(",").includes(file.type)) { toast({ variant: "destructive", title: "Use a PNG or JPG image" }); return; }
    if (file.size > MAX_BYTES) { toast({ variant: "destructive", title: "Image too large", description: "Use an image under 3 MB." }); return; }
    setBusy("upload");
    try {
      await api(`/employees/${employeeId}:uploadSignature?content_type=${encodeURIComponent(file.type)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      toast({ title: "Signature updated", variant: "success" });
      setVersion((v) => v + 1);
      onChanged?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't upload", description: (e as Error).message });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      await api(`/employees/${employeeId}:clearSignature`, { method: "POST" });
      toast({ title: "Signature removed", variant: "success" });
      setRemoved(true);
      onChanged?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't remove", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-4 sm:pt-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold"><PenLine className="h-4 w-4 text-primary" /> Signature
              <AccessTarget target={{ collection: "employees", objectPath: `employees/${employeeId}`, verb: "uploadSignature", label: "Signature" }} />
            </h3>
            <p className="text-xs text-muted-foreground">Used as your e-signature when you acknowledge policies and on generated letters.</p>
          </div>
        </div>

        <div className="flex min-h-[96px] items-center justify-center rounded-lg border bg-white p-4 dark:bg-brand-neutral-100">
          {src ? (
            /* `data-sentry-block` for the reason SignatureImage states: a data-URL signature is recorded whole
               by replay, and this route is not masked. */
            <img src={src} alt="Your signature" data-sentry-block className="max-h-24 max-w-full object-contain" />
          ) : (
            <span className="text-sm text-muted-foreground dark:text-brand-neutral-500">No signature uploaded yet.</span>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
            <Button size="sm" variant="outline" loading={busy === "upload"} disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy !== "upload" && <Upload className="h-4 w-4" />} {signature ? "Replace" : "Upload"}</Button>
            {signature && <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" loading={busy === "remove"} disabled={!!busy} onClick={remove}>{busy !== "remove" && <Trash2 className="h-4 w-4" />} Remove</Button>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
