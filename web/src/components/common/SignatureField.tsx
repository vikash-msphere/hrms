import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, PenLine } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AccessTarget } from "@/components/access/AccessTarget";
import { useToast } from "@/components/ui/use-toast";

// Fetch a signature image as a blob URL. `signature` is the resource marker (employees/<id>:getSignature) and
// `version` lets a parent force a refetch after upload/remove (the marker string is stable).
function useSignatureUrl(employeeId: string, signature?: string, version = 0) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let active = true;
    if (signature) {
      fetch(`/v1/employees/${employeeId}:getSignature`, { method: "POST", headers: { "X-Requested-By": "hrms-spa" }, credentials: "include" })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("no signature"))))
        .then((buf) => { if (!active) return; url = URL.createObjectURL(new Blob([buf], { type: "image/png" })); setSrc(url); })
        .catch(() => { if (active) setSrc(null); });
    } else {
      setSrc(null);
    }
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [employeeId, signature, version]);
  return src;
}

// Read-only signature image (used in the acknowledge dialog + HR acknowledgement view). Renders nothing when
// the employee has no signature on file.
export function SignatureImage({ employeeId, signature, className }: { employeeId: string; signature?: string; className?: string }) {
  const src = useSignatureUrl(employeeId, signature);
  if (!signature || !src) return null;
  return <img src={src} alt="Signature" className={className ?? "h-12 object-contain"} />;
}

const ACCEPT = "image/png,image/jpeg";
const MAX_BYTES = 3 * 1024 * 1024;

// Editable signature panel for a profile: shows the current signature on a white sheet, with upload/replace +
// remove. Upload/remove are gated by the caller (canEdit) and the server (self/HR via the employees path).
export function SignatureField({ employeeId, signature, canEdit, onChanged }: { employeeId: string; signature?: string; canEdit?: boolean; onChanged?: () => void }) {
  const { toast } = useToast();
  const [version, setVersion] = useState(0);
  const src = useSignatureUrl(employeeId, signature, version);
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
      setVersion((v) => v + 1);
      onChanged?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't remove", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
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
            <img src={src} alt="Your signature" className="max-h-24 max-w-full object-contain" />
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
