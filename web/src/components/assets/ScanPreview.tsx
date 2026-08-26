import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Pause, Play, SwitchCamera, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { lockPageScroll } from "@/lib/scrollLock";
import type { CameraFacing, CameraOption, CodeScanner, ZoomRange } from "@/lib/scanner";

// The camera preview every asset scanner shows - serial labels on the device (asset form, bulk add) and our
// own stickers (custody, stocktake) - so pausing and full screen exist once, for all of them.
//
// Why pause at all: a laptop lid carries the vendor's serial barcode, a regulatory barcode and our sticker
// within a few centimetres of each other, and a live loop reads whichever it happens to resolve first. Paused,
// the reader holds one frame and points at the code they meant; only that area gets decoded. Full screen is
// what makes that pointing practical on a phone, where the inline preview is a couple of centimetres tall.

type Drag = { x0: number; y0: number; x1: number; y1: number };

/** Rear lenses first: a label is scanned with one of those, and the front camera only ever gets picked by
 *  accident. */
const FACING_ORDER: CameraFacing[] = ["back", "front", "other"];
const FACING_LABEL: Record<CameraFacing, string> = { back: "Back", front: "Front", other: "Other" };

const groupCameras = (cameras: CameraOption[]) =>
  FACING_ORDER.map((facing) => ({ facing, cams: cameras.filter((c) => c.facing === facing) })).filter((g) => g.cams.length > 0);

/** The zoom factors worth one tap. On a phone that will not enumerate its rear lenses, these ARE the lenses:
 *  the bottom of the range is the ultrawide, 2x is where the telephoto takes over. Filtered to what this
 *  camera actually offers, so a webcam with a 1x-3x digital range shows two chips and not four. */
function zoomStops({ min, max }: ZoomRange): number[] {
  const wanted = [min, 1, 2, max].filter((v) => v >= min && v <= max);
  return [...new Set(wanted.map((v) => Math.round(v * 10) / 10))].sort((a, b) => a - b);
}

const fmtZoom = (v: number) => `${Math.round(v * 10) / 10}×`;

/** Below this the gesture was a tap, not a drag - the finger never really moved. */
const TAP_SLOP = 12;

/** Map a box drawn over the element onto the video's own pixels. Inline the preview is `object-cover` (a centre
 * crop of the frame); full screen it is `object-contain` (the whole frame, letterboxed). Both put the frame in
 * the middle, so the same arithmetic covers them once the scale is picked the right way round. */
function toVideoRect(video: HTMLVideoElement, box: Drag, fit: "cover" | "contain") {
  const r = video.getBoundingClientRect();
  if (!r.width || !r.height || !video.videoWidth || !video.videoHeight) return null;
  const byW = r.width / video.videoWidth;
  const byH = r.height / video.videoHeight;
  const scale = fit === "cover" ? Math.max(byW, byH) : Math.min(byW, byH);
  const offX = (video.videoWidth - r.width / scale) / 2;
  const offY = (video.videoHeight - r.height / scale) / 2;
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  if (x1 - x0 < TAP_SLOP && y1 - y0 < TAP_SLOP) {
    // A tap says "that one" without drawing anything, so read a slab around it - wider than tall, the shape a
    // 1D barcode comes in. Anything past the frame edge is clipped when the crop is cut.
    const w = r.width * 0.5;
    const h = r.height * 0.36;
    return { x: offX + ((x0 + x1) / 2 - w / 2) / scale, y: offY + ((y0 + y1) / 2 - h / 2) / scale, w: w / scale, h: h / scale };
  }
  return { x: offX + x0 / scale, y: offY + y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale };
}

/** Pause/resume, for the caller's own button row next to Stop camera. It lives there rather than on the picture
 * so nothing sits on top of the label being lined up; full screen has its own copy, since the row is not there. */
export function ScanPauseButton({ scanner, className }: { scanner: CodeScanner; className?: string }) {
  const { frozen, freeze, unfreeze } = scanner;
  return (
    <Button type="button" size="sm" variant="outline" className={className} onClick={frozen ? unfreeze : freeze}>
      {frozen ? (
        <>
          <Play className="h-4 w-4" /> Resume
        </>
      ) : (
        <>
          <Pause className="h-4 w-4" /> Pause
        </>
      )}
    </Button>
  );
}

export function ScanPreview({ scanner, className }: { scanner: CodeScanner; className?: string }) {
  const { videoRef, frozen, freeze, unfreeze, attach, decodeRegion, cameras, cameraId, selectCamera, switchingCamera, zoomRange, zoom, setZoom } = scanner;
  const groups = groupCameras(cameras);
  const [full, setFull] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(false);
  // The gesture is driven from a ref as well as state: pointerup has to read the box the moves left behind,
  // and that render may not have committed yet.
  const dragRef = useRef<Drag | null>(null);

  // Full screen is a portal to <body>: two of these previews live inside a dialog, and a dialog that is
  // centred with a transform makes `position: fixed` measure from the dialog instead of the viewport.
  // Re-parenting remounts the <video>, so the stream has to be put back on the new element.
  useEffect(() => {
    attach();
  }, [full, attach]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Inside a dialog Escape means "close the dialog". Full screen is the nearer thing on screen, so it
      // takes the key first - captured before the dialog's own document listener ever sees it.
      e.preventDefault();
      e.stopPropagation();
      setFull(false);
    };
    document.addEventListener("keydown", onKey, true);
    const unlock = lockPageScroll();
    return () => {
      document.removeEventListener("keydown", onKey, true);
      unlock();
    };
  }, [full]);

  function pointAt(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e: React.PointerEvent<HTMLDivElement>) {
    if (busy) return;
    const p = pointAt(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setMissed(false);
    dragRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    setDrag(dragRef.current);
  }

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const p = pointAt(e);
    dragRef.current = { ...dragRef.current, x1: p.x, y1: p.y };
    setDrag(dragRef.current);
  }

  async function onUp() {
    const box = dragRef.current;
    dragRef.current = null;
    const video = videoRef.current;
    if (!box || !video) return;
    const rect = toVideoRect(video, box, full ? "contain" : "cover");
    if (!rect) return;
    setBusy(true);
    const hit = await decodeRegion(rect);
    setBusy(false);
    setMissed(!hit);
    if (hit) {
      // The pick worked, so the held frame has done its job - go back to reading live.
      setDrag(null);
      unfreeze();
    }
  }

  const box = drag && {
    left: Math.min(drag.x0, drag.x1),
    top: Math.min(drag.y0, drag.y1),
    width: Math.abs(drag.x1 - drag.x0),
    height: Math.abs(drag.y1 - drag.y0),
  };
  const iconBtn = "rounded p-1.5 text-white/70 drop-shadow transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/70";

  const preview = (
    <div className={cn("relative", full ? "h-full w-full" : "overflow-hidden rounded-md border", className)}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        className={cn("bg-black", full ? "h-full w-full object-contain" : "aspect-video w-full object-cover")}
        muted
        playsInline
      />

      {frozen && (
        <div
          className="absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => void onUp()}
          onPointerCancel={() => {
            dragRef.current = null;
            setDrag(null);
          }}
        >
          {box && <div className="absolute rounded-sm border-2 border-primary bg-primary/10" style={box} />}
        </div>
      )}

      <div className="absolute right-1 top-1 flex items-center gap-1">
        {/* Which lens is reading. A phone offers a front camera and two or three rear ones that focus at very
            different distances, and the browser's default is not always the one that can read a label held
            close - so the reader picks, on the picture itself, where they are already looking. */}
        {cameras.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={switchingCamera}>
              <button type="button" className={iconBtn} title="Choose camera" aria-label="Choose camera">
                <SwitchCamera className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            {/* Above the full-screen preview, which is itself a z-[60] portal on <body>. */}
            <DropdownMenuContent align="end" className="z-[70] max-w-[min(20rem,calc(100vw-1.5rem))]">
              {groups.length === 1 && <DropdownMenuLabel>Camera</DropdownMenuLabel>}
              {groups.map((group, i) => (
                <Fragment key={group.facing}>
                  {groups.length > 1 && (
                    <>
                      {i > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel>{FACING_LABEL[group.facing]}</DropdownMenuLabel>
                    </>
                  )}
                  {group.cams.map((cam) => (
                    <DropdownMenuCheckboxItem
                      key={cam.deviceId}
                      checked={cam.deviceId === cameraId}
                      onCheckedChange={() => void selectCamera(cam.deviceId)}
                      // The OS string stays reachable: "camera2 3, facing back" means nothing to most people
                      // but is the only way an expert can tell which physical lens they just chose.
                      title={cam.raw}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{cam.label}</span>
                        {cam.detail && <span className="truncate text-xs text-muted-foreground">{cam.detail}</span>}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {full && (
          <button type="button" className={iconBtn} onClick={frozen ? unfreeze : freeze} title={frozen ? "Resume reading" : "Pause to pick a code"} aria-label={frozen ? "Resume reading" : "Pause to pick a code"}>
            {frozen ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
          </button>
        )}
        <button
          type="button"
          className={iconBtn}
          onClick={() => setFull(!full)}
          title={full ? "Leave full screen (Esc)" : "Full screen"}
          aria-label={full ? "Leave full screen" : "Full screen"}
        >
          {full ? <X className="h-5 w-5" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      {/* Zoom, where the browser admits to having it. This is the ultrawide/telephoto selector on any phone
          that hands over one virtual rear camera instead of a device per lens (every browser on iOS): the
          system swaps lens itself as the factor crosses the hardware thresholds. It also earns its place on
          the main lens - a sticker on a rack two metres up is unreadable at 1x. */}
      {zoomRange && !frozen && !switchingCamera && (
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/60 to-transparent px-2 pt-6",
            // env() is not positional - it reports the device inset wherever the element sits - so the home
            // indicator is only worth clearing in the full-screen copy, which really is at the screen edge.
            full ? "pb-[max(0.5rem,env(safe-area-inset-bottom))]" : "pb-2",
          )}
        >
          <input
            type="range"
            min={zoomRange.min}
            max={zoomRange.max}
            step={zoomRange.step}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full accent-primary"
            aria-label="Camera zoom"
          />
          <div className="flex items-center justify-between gap-1">
            <span className="text-[11px] leading-4 tabular-nums text-white/80 drop-shadow">{fmtZoom(zoom)}</span>
            <div className="flex items-center gap-1">
              {zoomStops(zoomRange).map((stop) => (
                <button
                  key={stop}
                  type="button"
                  onClick={() => setZoom(stop)}
                  className={cn(
                    "rounded px-2 py-1 text-[11px] leading-4 tabular-nums drop-shadow transition-colors coarse:px-3 coarse:py-2",
                    Math.round(zoom * 10) === Math.round(stop * 10) ? "bg-white/25 text-white" : "text-white/70 hover:text-white",
                  )}
                >
                  {fmtZoom(stop)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Only says something while it has something to say - switching lens, paused, mid-read, or a pick that
          read nothing. A camera swap blanks the picture for a moment, so it says why. */}
      {(switchingCamera || frozen) && (
        <span className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[11px] leading-4 text-white/80 drop-shadow">
          {switchingCamera
            ? "Switching camera…"
            : busy
              ? "Reading that area…"
              : missed
                ? "Nothing readable there - try again"
                : "Drag a box around the code, or tap it"}
        </span>
      )}
    </div>
  );

  return full ? createPortal(<div className="fixed inset-0 z-[60] bg-black">{preview}</div>, document.body) : preview;
}
