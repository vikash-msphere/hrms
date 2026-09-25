import { useEffect, useRef, useState } from "react";
import { Camera, Upload } from "lucide-react";
import { api } from "@/api";
import { colorFromString, initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { FormError } from "@/components/common/FormError";
import { useConfirm } from "@/components/common/confirm";
import { AccessTarget } from "@/components/access/AccessTarget";
import { AccessAction } from "@/components/access/AccessAction";

const VP = 256; // crop viewport (px)
const OUT = 512; // exported square (px)
const MAX_BYTES = 10 * 1024 * 1024; // what a phone camera produces, with room to spare

/** Profile avatar that shows the employee's photo (fetched as a blob) and, when editable,
 *  lets the owner/HR/super_admin upload (with crop + zoom) or remove it. */
export function PhotoAvatar({
  employeeId,
  name,
  photo,
  editable,
  onChanged,
  className = "h-16 w-16",
  open: openProp,
  onOpenChange,
}: {
  employeeId: string;
  name: string;
  photo?: string;
  editable?: boolean;
  onChanged?: () => void;
  className?: string;
  // Optional controlled open, so the upload dialog can also be opened from outside the avatar's
  // hover overlay (the profile completeness meter's "Profile photo" chip does).
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = onOpenChange ?? setOpenLocal;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // True once a NEW image has been chosen in this session - the only state worth protecting on close, since
  // the crop of an already-saved photo can be redone in a second.
  const [picked, setPicked] = useState(false);
  // THE MARKER IS THE URL. `photo` is what the server serves on the row (http/serialize.ts#photoMarker):
  // `employees/<id>:getPhoto?v=<version>`, an API path whose `?v=` is the picture's own version. So the face is
  // an ordinary `<img>` the browser fetches, caches for a week and lazy-loads when it scrolls into view, and a
  // replaced photo is simply a different URL - nothing has to be told anything, in this tab or any other. The
  // app used to carry a cache of its own (batched fetches, base64 payloads, a disk layer) to do that job.
  const src = photo ? `/v1/${photo}` : null;
  // A photo that will not load - deleted underneath us, a refused request - falls back to initials rather than
  // leaving the browser's broken-image glyph in a circle. Reset per URL, so a new photo gets its own chance.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

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
    e.target.value = ""; // so re-picking the same file after an error still fires a change
    if (!file) return;
    // Caught here rather than at the upload: the crop step re-encodes to a 512px JPEG, so a rejected giant
    // would otherwise only fail after someone had finished positioning it.
    if (!file.type.startsWith("image/")) {
      setErr("That's not an image. Pick a JPEG, PNG or HEIC file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setErr(`That image is ${(file.size / 1024 / 1024).toFixed(1)}MB. Pick one under ${MAX_BYTES / 1024 / 1024}MB.`);
      return;
    }
    setErr(null);
    const reader = new FileReader();
    reader.onload = () => {
      setImgSrc(reader.result as string);
      setPicked(true);
      setZoom(1);
      setOff({ x: 0, y: 0 });
      setNat(null);
    };
    reader.onerror = () => setErr("Couldn't read that file.");
    reader.readAsDataURL(file);
  }

  // Closing after picking an image discards it, so ask - the same interception the form dialogs use, applied
  // to the one piece of work in here that can't be redone in a click.
  async function requestClose(next: boolean) {
    if (next) return;
    if (picked && !(await confirm({ title: "Discard this photo?", description: "The image you picked hasn't been saved yet.", destructive: true, confirmLabel: "Discard", cancelLabel: "Keep editing" }))) return;
    setOpen(false);
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
    setPicked(false);
  }

  // Init on open (whether via the hover overlay or the controlled prop): reset the crop and preload
  // the current photo into the cropper so it can be re-adjusted.
  useEffect(() => {
    if (!open) return;
    setZoom(1);
    setOff({ x: 0, y: 0 });
    setNat(null);
    setImgSrc(src);
    setPicked(false);
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    if (!nat || !imgRef.current) return;
    setSaving(true);
    setErr(null);
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
      // Nothing to invalidate: the row's `photo` marker now carries a new version, so re-reading the record is
      // what puts the new picture on screen - here and in every other tab and browser showing this person.
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!(await confirm({ title: "Remove this photo?", description: "Their avatar falls back to initials everywhere it appears. The image can't be recovered.", destructive: true, confirmLabel: "Remove" }))) return;
    setSaving(true);
    setErr(null);
    try {
      await api(`/employees/${employeeId}:clearPhoto`, { method: "POST" });
      toast({ title: "Photo removed", variant: "success" });
      setOpen(false);
      reset();
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="relative">
        <Avatar className={className}>
          {/* A plain `<img>`, NOT Radix's AvatarImage: that one tracks its load state through `new Image()`,
              which fetches eagerly and would defeat `loading="lazy"` - and a directory is the one screen where
              only the rows on screen should be fetched. The initials sit underneath and show through until
              (or unless) the picture paints over them. */}
          {src && !broken && (
            <img
              src={src}
              alt={name}
              loading="lazy"
              decoding="async"
              onError={() => setBroken(true)}
              // NO z-index. Absolute already lifts it over the initials underneath, and the "Change photo"
              // overlay is a later sibling of this Avatar, so it paints above the picture on its own. A `z-10`
              // here put the image over that button instead: with a photo set, the one affordance for
              // replacing it stopped taking clicks.
              className="absolute inset-0 aspect-square h-full w-full object-cover"
            />
          )}
          <AvatarFallback className="text-lg" style={{ backgroundColor: colorFromString(name) }}>{initials(name)}</AvatarFallback>
        </Avatar>
        {editable && (
          <button
            type="button"
            onClick={() => setOpen(true)}
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

      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Profile photo</DialogTitle>
            <DialogDescription>Shown wherever {name} appears - the directory, approvals, the org chart. Saved as a 512px square.</DialogDescription>
          </DialogHeader>

          <FormError error={err} />

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
            {/* order-last on a phone: the footer is a reversed column there, so being first in the markup
                would put "Remove photo" at the bottom edge - under the thumb, below Cancel. */}
            {photo ? (
              <span className="order-last sm:order-none">
                <AccessAction collection="employees" objectPath={`employees/${employeeId}`} verb="clearPhoto" label="Remove photo">
                  <Button variant="ghost" className="w-full text-destructive hover:text-destructive sm:w-auto" onClick={remove} loading={saving}>
                    Remove photo
                  </Button>
                </AccessAction>
              </span>
            ) : (
              <span className="order-last sm:order-none" />
            )}
            {/* Reversed to match DialogFooter's own stacking: primary above, Cancel at the bottom edge. */}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => requestClose(false)}>Cancel</Button>
              {imgSrc && <Button onClick={save} loading={saving} disabled={!nat}>Save photo</Button>}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
