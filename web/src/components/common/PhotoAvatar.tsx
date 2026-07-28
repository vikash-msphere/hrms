import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Upload } from "lucide-react";
import { api } from "@/api";
import { requestPhoto, subscribePhoto, invalidatePhoto } from "@/lib/photoCache";
import { cn, colorFromString, initials } from "@/lib/utils";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { AccessTarget } from "@/components/access/AccessTarget";
import { AccessAction } from "@/components/access/AccessAction";

const VP = 256; // crop viewport (px)
const OUT = 512; // exported square (px)

/** Profile avatar that shows the employee's photo (fetched as a blob) and, when editable,
 *  lets the owner/HR/super_admin upload (with crop + zoom) or remove it. */
export function PhotoAvatar({
  employeeId,
  name,
  photo,
  editable,
  onChanged,
  className = "h-16 w-16",
}: {
  employeeId: string;
  name: string;
  photo?: string;
  editable?: boolean;
  onChanged?: () => void;
  className?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // The photo bytes come from the shared session cache, which batches every avatar mounted in the same tick
  // into one `employees:batchGetPhotos` request (no per-avatar fetch). `src` is a data URI or null.
  const src = useSyncExternalStore(
    (cb) => subscribePhoto(employeeId, cb),
    () => requestPhoto(employeeId, !!photo),
  );

  // crop state
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const baseScale = nat ? Math.max(VP / nat.w, VP / nat.h) : 1;
  const scale = baseScale * zoom;
  const dispW = nat ? nat.w * scale : VP;
  const dispH = nat ? nat.h * scale : VP;

  function clampOff(x: number, y: number) {
    return { x: Math.min(0, Math.max(VP - dispW, x)), y: Math.min(0, Math.max(VP - dispH, y)) };
  }
  useEffect(() => {
    setOff((o) => clampOff(o.x, o.y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, nat]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImgSrc(reader.result as string);
      setZoom(1);
      setOff({ x: 0, y: 0 });
      setNat(null);
    };
    reader.readAsDataURL(file);
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { sx: e.clientX, sy: e.clientY, ox: off.x, oy: off.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setOff(clampOff(drag.current.ox + (e.clientX - drag.current.sx), drag.current.oy + (e.clientY - drag.current.sy)));
  }

  function reset() {
    setImgSrc(null);
    setNat(null);
    setZoom(1);
    setOff({ x: 0, y: 0 });
  }

  function openDialog() {
    setZoom(1);
    setOff({ x: 0, y: 0 });
    setNat(null);
    // Preload the current photo into the cropper so it can be re-adjusted.
    setImgSrc(src);
    setOpen(true);
  }

  async function save() {
    if (!nat || !imgRef.current) return;
    setSaving(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext("2d")!;
      const sVP = VP / scale;
      ctx.drawImage(imgRef.current, -off.x / scale, -off.y / scale, sVP, sVP, 0, 0, OUT, OUT);
      const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.9));
      await api(`/employees/${employeeId}:uploadPhoto?content_type=image/jpeg`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob,
      });
      toast({ title: "Photo updated", variant: "success" });
      setOpen(false);
      reset();
      invalidatePhoto(employeeId); // drop the stale cached photo + refetch
      onChanged?.();
    } catch (e) {
      toast({ title: "Couldn't upload", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await api(`/employees/${employeeId}:clearPhoto`, { method: "POST" });
      toast({ title: "Photo removed", variant: "success" });
      invalidatePhoto(employeeId);
      setOpen(false);
      reset();
      onChanged?.();
    } catch (e) {
      toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="relative">
        <Avatar className={className}>
          {src && <AvatarImage src={src} alt={name} />}
          <AvatarFallback className="text-lg" style={{ backgroundColor: colorFromString(name) }}>{initials(name)}</AvatarFallback>
        </Avatar>
        {editable && (
          <button
            type="button"
            onClick={openDialog}
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-transparent transition-colors hover:bg-black/50 hover:text-white"
            title="Change photo"
            aria-label="Change photo"
          >
            <Camera className="h-5 w-5" />
          </button>
        )}
        {editable && (
          // Manage-access icon for the photo (a custom method on the employee). Positioned at the corner so it
          // doesn't disturb the circular overlay button; self-hides when access mode is off.
          <span className="absolute -right-1 -top-1 z-10">
            <AccessTarget target={{ collection: "employees", objectPath: `employees/${employeeId}`, verb: "uploadPhoto", label: "Profile photo" }} />
          </span>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Profile photo</DialogTitle>
          </DialogHeader>

          {!imgSrc ? (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-sm text-muted-foreground hover:bg-muted/40">
              <Upload className="h-6 w-6" />
              Choose an image to upload
              <input type="file" accept="image/*" className="hidden" onChange={onFile} />
            </label>
          ) : (
            <div className="space-y-3">
              <label className="flex cursor-pointer items-center justify-center gap-2 text-xs font-medium text-primary hover:underline">
                <Upload className="h-3.5 w-3.5" /> Choose a different image
                <input type="file" accept="image/*" className="hidden" onChange={onFile} />
              </label>
              <div
                className="mx-auto select-none overflow-hidden rounded-full bg-muted ring-1 ring-border"
                style={{ width: VP, height: VP, position: "relative", touchAction: "none" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={() => (drag.current = null)}
                onPointerLeave={() => (drag.current = null)}
              >
                <img
                  ref={imgRef}
                  src={imgSrc}
                  draggable={false}
                  onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                  style={{ position: "absolute", left: off.x, top: off.y, width: dispW, height: dispH, maxWidth: "none", cursor: "grab" }}
                  alt="crop preview"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Zoom</span>
                <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full accent-primary" />
              </div>
              <p className="text-center text-xs text-muted-foreground">Drag to reposition</p>
            </div>
          )}

          <DialogFooter className="sm:justify-between">
            {photo ? (
              <AccessAction collection="employees" objectPath={`employees/${employeeId}`} verb="clearPhoto" label="Remove photo">
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={remove} loading={saving}>
                  Remove photo
                </Button>
              </AccessAction>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              {imgSrc && <Button onClick={save} loading={saving} disabled={!nat}>Save photo</Button>}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
