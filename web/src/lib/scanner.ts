import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DecodeHintType } from "@zxing/library";

// Reading a code off a physical label, in the places that need it: the stocktake walk-through, the one-asset
// custody confirmation, and the manufacturer serial on an asset being added or edited. They all want the same
// thing - a live camera loop, a photo-upload fallback, and a decoder that works in browsers without
// BarcodeDetector - so it lives here rather than three times.
//
// Decoding: the native BarcodeDetector where the browser has it, otherwise the bundled ZXing reader, loaded
// lazily on first decode so nothing ships in the app entry. Both paths honour the SAME format list, so a
// caller asking for 1D barcodes gets them on Safari (no BarcodeDetector) as well as on Chrome.

export type ScanFormat =
  | "qr_code"
  | "data_matrix"
  | "aztec"
  | "pdf417"
  | "code_128"
  | "code_39"
  | "code_93"
  | "codabar"
  | "itf"
  | "ean_13"
  | "ean_8"
  | "upc_a"
  | "upc_e";

/** Our own asset stickers: a QR deep link, or a Code 128 of the tag text (see AssetTagSettings.code_type). */
export const TAG_FORMATS: ScanFormat[] = ["qr_code", "code_128"];

/** A manufacturer's serial label, where the vendor chose the symbology and we get no say in it. Code 128 and
 *  Code 39 cover most device labels; Data Matrix is common on small parts, and the retail formats show up on
 *  consumer boxes. Kept broad on purpose: a format we leave out is a label that silently will not scan. */
export const SERIAL_FORMATS: ScanFormat[] = [
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "itf",
  "data_matrix",
  "qr_code",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "pdf417",
  "aztec",
];

const TWO_D: ScanFormat[] = ["qr_code", "data_matrix", "aztec", "pdf417"];
const has1D = (formats: ScanFormat[]) => formats.some((f) => !TWO_D.includes(f));

// BarcodeDetector is not in TS's dom lib yet. Nor is camera zoom: the dom lib knows `MediaTrackSettings.zoom`
// but neither the capability that advertises it nor the constraint that sets it, so both are merged in here.
declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts?: { formats?: string[] }): { detect(source: CanvasImageSource): Promise<{ rawValue: string; format?: string }[]> };
      getSupportedFormats?(): Promise<string[]>;
    };
  }
  interface MediaTrackCapabilities {
    zoom?: DoubleRange & { step?: number };
  }
  interface MediaTrackConstraintSet {
    zoom?: ConstrainDouble;
  }
}
type NativeDetector = InstanceType<NonNullable<Window["BarcodeDetector"]>>;

export type CameraState = "off" | "starting" | "on" | "unavailable";

/** One camera the browser will hand over, named the way a person can choose between them. `raw` is the OS
 *  string, which only exists once permission has been granted - so the list is worth reading after
 *  `getUserMedia`, never before it. `detail` is whatever we can say to tell two rear lenses apart. */
export type CameraOption = { deviceId: string; label: string; detail: string; facing: CameraFacing; raw: string };

export type CameraFacing = "back" | "front" | "other";

/** How far a lens will zoom, when the browser admits to having the control at all. */
export type ZoomRange = { min: number; max: number; step: number };

// Which camera to open, remembered per device (not per user): a phone with three back lenses, a laptop with a
// webcam plus a plugged-in document camera, and a tablet are three different answers for the same person, so
// this stays in localStorage rather than the cross-device preferences row.
const CAMERA_KEY = "hrms.scanCamera";

const readSavedCamera = (): string | null => {
  try {
    return localStorage.getItem(CAMERA_KEY) || null;
  } catch {
    return null; // private mode, or storage blocked - the default camera is still fine
  }
};

const saveCamera = (deviceId: string) => {
  try {
    localStorage.setItem(CAMERA_KEY, deviceId);
  } catch {
    /* the pick still applies to this session; it just will not be remembered */
  }
};

/** Open the wanted camera, falling back to the rear-facing default. A remembered deviceId goes stale often -
 *  a different phone, an unplugged webcam, a browser that rotates its ids per origin session - and `exact`
 *  makes that a hard failure, so the fallback is what keeps the scanner working. `opened` says which camera
 *  the caller actually got, or null when the fallback ran and the browser chose. */
async function openCamera(deviceId: string | null): Promise<{ stream: MediaStream; opened: string | null }> {
  if (deviceId) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } }), opened: deviceId };
    } catch {
      /* fall through to the default below */
    }
  }
  return { stream: await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }), opened: null };
}

/** Which way a camera points. Chromium hands back `InputDeviceInfo` objects, whose `getCapabilities()` answers
 *  this WITHOUT opening the camera - the reliable path. Everywhere else (WebKit) the OS label is all there is:
 *  "Back Camera"/"Front Camera" on iOS, "camera2 0, facing back" on Android browsers without the interface. */
const deviceCaps = (device: MediaDeviceInfo): MediaTrackCapabilities | null => {
  // Duck-typed rather than `instanceof InputDeviceInfo`: the interface does not exist on WebKit at all, and
  // naming a missing global throws.
  const get = (device as Partial<InputDeviceInfo>).getCapabilities;
  try {
    return typeof get === "function" ? get.call(device) : null;
  } catch {
    return null; // Firefox has the method and throws from it
  }
};

function facingOf(device: MediaDeviceInfo): CameraFacing {
  const mode = deviceCaps(device)?.facingMode?.[0];
  if (mode === "environment") return "back";
  if (mode === "user") return "front";
  const label = device.label.toLowerCase();
  if (/\bback\b|rear|environment/.test(label)) return "back";
  if (/\bfront\b|user|face/.test(label)) return "front";
  return "other";
}

/** Something to tell two rear lenses apart by. The ultrawide, main and telephoto modules of one phone are
 *  three different sensors, and their maximum frame size usually differs - which is the only discriminator a
 *  browser gives away for free, since nothing in the API reports focal length or field of view. */
function detailOf(device: MediaDeviceInfo): string {
  const caps = deviceCaps(device);
  const w = caps?.width?.max;
  const h = caps?.height?.max;
  return w && h ? `up to ${w} × ${h}` : "";
}

/** Name the cameras for the picker. Android's own labels ("camera2 3, facing back") are serial numbers with a
 *  direction attached, so they are rebuilt as "Back camera 2" and numbered within their facing group; iOS
 *  already says "Back Camera", which is kept as it is. The OS string survives in `raw` for the row's tooltip. */
function toCameraOptions(devices: MediaDeviceInfo[]): CameraOption[] {
  const cams = devices.filter((d) => d.kind === "videoinput");
  const seen: Record<CameraFacing, number> = { back: 0, front: 0, other: 0 };
  const counts = cams.reduce<Record<CameraFacing, number>>(
    (acc, d) => {
      acc[facingOf(d)]++;
      return acc;
    },
    { back: 0, front: 0, other: 0 },
  );
  return cams.map((d, i) => {
    const facing = facingOf(d);
    const nth = ++seen[facing];
    const word = facing === "other" ? "Camera" : facing === "back" ? "Back camera" : "Front camera";
    // A plain "camera2 N, facing back" carries nothing a person can use, so it is replaced outright; a name a
    // human wrote ("FaceTime HD Camera", "Back Camera") is kept.
    const generic = !d.label || /^camera2?\s/i.test(d.label);
    const label = generic ? (counts[facing] > 1 ? `${word} ${nth}` : word) : d.label;
    return { deviceId: d.deviceId, label, detail: detailOf(d), facing, raw: d.label || label };
  });
}

/** The zoom control, when the browser has one. Chromium reports a range on phone cameras; WebKit reports none
 *  on older iOS, and there the control simply is not rendered. */
function zoomOf(stream: MediaStream): ZoomRange | null {
  const caps = stream.getVideoTracks()[0]?.getCapabilities?.();
  const zoom = caps?.zoom;
  if (!zoom || zoom.min === undefined || zoom.max === undefined || zoom.max <= zoom.min) return null;
  return { min: zoom.min, max: zoom.max, step: zoom.step && zoom.step > 0 ? zoom.step : 0.1 };
}

/** True when the browser decodes natively. Both paths read the same formats now, so this is only worth
 *  telling a reader about when explaining why a decode is taking a moment (the fallback is slower). */
export const hasNativeDetector = () => !!window.BarcodeDetector;

/** One decoded code: what it said, and which symbology it came from (lower-case, as BarcodeDetector names them). */
export type Scan = { raw: string; format: string };

type GrayDecoder = (gray: Uint8ClampedArray, w: number, h: number) => Scan | null;

// ZXing's own enum names, keyed by the BarcodeDetector spelling we take from callers.
const ZX_FORMAT: Record<ScanFormat, string> = {
  qr_code: "QR_CODE",
  data_matrix: "DATA_MATRIX",
  aztec: "AZTEC",
  pdf417: "PDF_417",
  code_128: "CODE_128",
  code_39: "CODE_39",
  code_93: "CODE_93",
  codabar: "CODABAR",
  itf: "ITF",
  ean_13: "EAN_13",
  ean_8: "EAN_8",
  upc_a: "UPC_A",
  upc_e: "UPC_E",
};

async function loadZxing(formats: ScanFormat[]): Promise<GrayDecoder> {
  const zx = await import("@zxing/library");
  const wanted = formats.map((f) => zx.BarcodeFormat[ZX_FORMAT[f] as keyof typeof zx.BarcodeFormat]).filter((v) => v !== undefined);
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, wanted);
  // Worth the extra passes here: a hand-held phone over a curved laptop lid is exactly the marginal image
  // TRY_HARDER exists for, and we are decoding a few frames a second, not a batch of scans.
  hints.set(zx.DecodeHintType.TRY_HARDER, true);
  const reader = new zx.MultiFormatReader();
  reader.setHints(hints);
  const readOnce = (gray: Uint8ClampedArray, w: number, h: number): Scan | null => {
    try {
      const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(gray, w, h)));
      const result = reader.decodeWithState(bitmap);
      const name = zx.BarcodeFormat[result.getBarcodeFormat()] ?? "";
      return { raw: result.getText(), format: name.toLowerCase().replace("pdf_417", "pdf417") };
    } catch {
      return null; // nothing in frame is the normal case, not an error
    } finally {
      reader.reset();
    }
  };
  const rotate = has1D(formats);
  return (gray, w, h) => {
    const hit = readOnce(gray, w, h);
    if (hit || !rotate) return hit;
    // RGBLuminanceSource cannot rotate itself, so ZXing's 1D readers only ever sweep horizontal lines. A
    // serial label photographed sideways (or a barcode printed vertically down a chassis) is invisible to
    // them until we hand over a turned copy of the frame.
    const turned = new Uint8ClampedArray(gray.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) turned[x * h + (h - 1 - y)] = gray[y * w + x]!;
    return readOnce(turned, h, w);
  };
}

/** An area of a frame, in the source's own pixels (video frames and photos are both bigger than the box they
 * are shown in, so a picked area only survives the trip if it is expressed in the frame's own coordinates). */
export type Rect = { x: number; y: number; w: number; h: number };

const clampRect = (r: Rect, srcW: number, srcH: number): Rect => {
  const x = Math.max(0, Math.min(srcW, Math.round(r.x)));
  const y = Math.max(0, Math.min(srcH, Math.round(r.y)));
  return { x, y, w: Math.min(srcW - x, Math.round(r.w)), h: Math.min(srcH - y, Math.round(r.h)) };
};

/** Draw `region` of `src` onto `canvas`, long side capped at `cap` px - decoding cost grows with pixel count.
 * A small pick is blown up instead: a crop of a few hundred pixels has narrow 1D bars sitting on one or two
 * pixels each, and both decoders read those better with some room around them. */
function drawRegion(canvas: HTMLCanvasElement, src: CanvasImageSource, region: Rect, cap: number) {
  const long = Math.max(region.w, region.h);
  if (!long) return null;
  const scale = Math.min(long < 640 ? 2 : 1, cap / long);
  const w = Math.max(1, Math.round(region.w * scale));
  const h = Math.max(1, Math.round(region.h * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, w, h);
  return { ctx, w, h };
}

/**
 * A camera scanning loop plus a still-image decoder, over `formats`.
 *
 * `onScan` fires at most once per code per 3s (the same label sits in frame for dozens of frames).
 */
export function useCodeScanner(onScan: (raw: string, scan: Scan) => void, opts?: { formats?: ScanFormat[] }) {
  const formats = useMemo(() => opts?.formats ?? TAG_FORMATS, [opts?.formats]);
  const [cameraState, setCameraState] = useState<CameraState>("off");
  // Two labels side by side on one laptop lid is the normal case, and a live loop just reads whichever it
  // reaches first. Freezing holds the preview on one frame so the reader can point at the code they meant;
  // the ref is what the loop reads, the state is what the preview renders.
  const [frozen, setFrozen] = useState(false);
  const frozenRef = useRef(false);
  // The cameras on offer, and which one is live. `cameraId` is the camera actually feeding the preview - set
  // from the running track, so it ticks the right menu row whether the reader picked it or it was the default.
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [switchingCamera, setSwitchingCamera] = useState(false);
  // On a phone that will not enumerate its rear lenses individually - every browser on iOS - zoom IS the lens
  // selector: the system swaps to the ultrawide below 1x and to the telephoto above 2x. Null where the
  // browser has no zoom control at all, and then nothing is rendered for it.
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);
  const [zoom, setZoom] = useState(1);
  // The remembered pick, read once (a lazy initialiser, so this is not a localStorage hit per render).
  const [savedCamera] = useState(readSavedCamera);
  const wantedCameraRef = useRef<string | null>(savedCamera);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<NativeDetector | null>(null);
  const zxingRef = useRef<GrayDecoder | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The same code stays in frame for many ticks; without this the loop would fire dozens of times a second.
  const lastHitRef = useRef<{ raw: string; at: number }>({ raw: "", at: 0 });
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  // Decode one frame/image, or one picked `crop` of it. Large sources are downscaled first - decoding cost
  // grows with pixel count - but a 1D barcode needs its narrow bars to survive that scaling, so it keeps a
  // bigger budget than a QR does.
  const decodeSource = useCallback(
    async (src: HTMLVideoElement | ImageBitmap, crop?: Rect): Promise<Scan | null> => {
      const srcW = src instanceof ImageBitmap ? src.width : src.videoWidth;
      const srcH = src instanceof ImageBitmap ? src.height : src.videoHeight;
      if (!srcW || !srcH) return null;
      const region = crop ? clampRect(crop, srcW, srcH) : { x: 0, y: 0, w: srcW, h: srcH };
      if (!region.w || !region.h) return null;
      const wide = has1D(formats);
      const cap = src instanceof ImageBitmap ? (wide ? 2000 : 1600) : wide ? 1280 : 800;
      if (window.BarcodeDetector) {
        if (!detectorRef.current) {
          // Constructing with a format this browser does not know throws, so ask it what it has first.
          const supported = (await window.BarcodeDetector.getSupportedFormats?.()) ?? formats;
          const usable = formats.filter((f) => supported.includes(f));
          if (!usable.length) return null;
          detectorRef.current = new window.BarcodeDetector({ formats: usable });
        }
        // A native detector reads a whole source and picks the first code it finds, so honouring a pick means
        // cutting it out onto a canvas and handing that over instead.
        let target: CanvasImageSource = src;
        if (crop) {
          const canvas = (canvasRef.current ??= document.createElement("canvas"));
          if (!drawRegion(canvas, src, region, cap)) return null;
          target = canvas;
        }
        const codes = await detectorRef.current.detect(target);
        const first = codes[0];
        return first ? { raw: first.rawValue, format: first.format ?? "" } : null;
      }
      zxingRef.current ??= await loadZxing(formats);
      const canvas = (canvasRef.current ??= document.createElement("canvas"));
      const drawn = drawRegion(canvas, src, region, cap);
      if (!drawn) return null;
      const { ctx, w, h } = drawn;
      const { data } = ctx.getImageData(0, 0, w, h);
      // Green-favouring luminance, the same cheap average ZXing uses internally for RGBA input.
      const gray = new Uint8ClampedArray(w * h);
      for (let i = 0, p = 0; p < gray.length; i += 4, p++) gray[p] = (data[i]! + 2 * data[i + 1]! + data[i + 2]!) / 4;
      return zxingRef.current(gray, w, h);
    },
    [formats],
  );

  const setFrozenBoth = useCallback((v: boolean) => {
    frozenRef.current = v;
    setFrozen(v);
  }, []);

  const stopCamera = useCallback(() => {
    if (videoRef.current) videoRef.current.srcObject = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setFrozenBoth(false);
    setCameraState("off");
    setSwitchingCamera(false);
    setZoomRange(null);
  }, [setFrozenBoth]);

  /** Ask the live track for a zoom factor. `advanced` on purpose: a browser that cannot honour the value drops
   *  the whole advanced set instead of rejecting, so a stubborn camera keeps streaming rather than dying. */
  const applyZoom = useCallback((value: number) => {
    setZoom(value);
    const track = streamRef.current?.getVideoTracks()[0];
    void track?.applyConstraints({ advanced: [{ zoom: value }] }).catch(() => {
      /* the camera kept whatever factor it had; the slider is the only thing now out of step */
    });
  }, []);

  /** Note the running camera and read the device list. Called after every successful open: the labels only
   *  exist post-permission, and the id we asked for is not always the id we got (a stale pick falls back).
   *  Safari does not always report `deviceId` on a track, hence the `opened` fallback - which is only a real
   *  answer when the exact constraint is what succeeded. */
  const noteOpenedCamera = useCallback(async (stream: MediaStream, opened: string | null) => {
    const track = stream.getVideoTracks()[0];
    const live = track?.getSettings().deviceId || opened;
    if (live) setCameraId(live);
    // Every lens has its own zoom range, so this is re-read per open. The factor starts at whatever the track
    // reports, else 1x - never at the range floor, which on a virtual multi-lens camera is the ultrawide and
    // would open the scanner on the one lens that cannot focus on a label held close.
    const range = zoomOf(stream);
    setZoomRange(range);
    setZoom(track?.getSettings().zoom ?? (range ? Math.min(Math.max(1, range.min), range.max) : 1));
    try {
      setCameras(toCameraOptions(await navigator.mediaDevices.enumerateDevices()));
    } catch {
      /* a browser that will not enumerate just gets no picker - the camera itself is already running */
    }
  }, []);

  const startCamera = useCallback(async () => {
    setFrozenBoth(false);
    setCameraState("starting");
    // Restarting without stopping first leaves the previous stream running (and the recording light on).
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      const { stream, opened } = await openCamera(wantedCameraRef.current);
      streamRef.current = stream;
      setCameraState("on");
      void noteOpenedCamera(stream, opened);
    } catch {
      setCameraState("unavailable");
    }
  }, [noteOpenedCamera, setFrozenBoth]);

  /** Hold the preview on the frame that is on screen now. The stream keeps running (so resuming is instant);
   * only the element and the read loop stop, and the held frame stays readable through `decodeRegion`. */
  const freeze = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    video.pause();
    setFrozenBoth(true);
  }, [setFrozenBoth]);

  /** Re-bind the running stream to whatever <video> is mounted now. Going in and out of full screen re-parents
   * the preview, which React does by mounting a fresh element - without this it comes up black. A held frame
   * does not travel with the element, so a paused preview re-takes its still from the live stream. */
  const attach = useCallback(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video
      .play()
      .then(() => {
        if (frozenRef.current) video.pause();
      })
      .catch(() => {
        /* autoplay refusal on a muted inline element is not something the reader can act on */
      });
  }, []);

  /** Point the scanner at another camera. Phones carry several rear lenses that focus at very different
   *  distances (the ultra-wide cannot read a label held 10 cm away, the main one can), and a laptop's built-in
   *  webcam is the wrong one when a document camera is plugged in - so which camera to use is the reader's
   *  call, and it is remembered for next time.
   *
   *  The running stream is stopped BEFORE the new one is asked for: a phone refuses a second camera while the
   *  first still holds the sensor, so keeping the old one as a safety net would break the very switch it
   *  guards. `cameraState` stays "on" across the swap, so the preview element is never torn down. */
  const selectCamera = useCallback(
    async (deviceId: string) => {
      wantedCameraRef.current = deviceId;
      saveCamera(deviceId);
      if (deviceId === cameraId) return; // already live - the pick only made the default explicit
      if (!streamRef.current) {
        setCameraId(deviceId); // camera is off: the pick applies at the next start
        return;
      }
      setSwitchingCamera(true);
      setFrozenBoth(false);
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      try {
        const { stream, opened } = await openCamera(deviceId);
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          void video.play().catch(() => {
            /* the element is already on screen; a refused resume leaves the last frame up */
          });
        }
        await noteOpenedCamera(stream, opened);
      } catch {
        setCameraState("unavailable");
      } finally {
        setSwitchingCamera(false);
      }
    },
    [cameraId, noteOpenedCamera, setFrozenBoth],
  );

  const unfreeze = useCallback(() => {
    setFrozenBoth(false);
    void videoRef.current?.play().catch(() => {
      /* the element is already visible by now; a refused resume just leaves the still frame up */
    });
  }, [setFrozenBoth]);

  // Callers mount the <video> only once the camera reads "on", so the element does not exist yet while the
  // permission prompt is up. Bind the stream here, after that render, or the preview stays black.
  useEffect(() => {
    if (cameraState !== "on") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      /* autoplay can be refused until the element is visible; the loop picks up once it plays */
    });
  }, [cameraState]);

  // The read loop runs only while the camera is on, and tears itself down with it.
  useEffect(() => {
    if (cameraState !== "on") return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const video = videoRef.current;
      if (video && !frozenRef.current && video.readyState >= 2) {
        try {
          const hit = await decodeSource(video);
          if (hit && !(lastHitRef.current.raw === hit.raw && Date.now() - lastHitRef.current.at < 3000)) {
            lastHitRef.current = { raw: hit.raw, at: Date.now() };
            onScanRef.current(hit.raw, hit);
          }
        } catch {
          /* decode errors are normal - nothing in frame */
        }
      }
      setTimeout(tick, 250);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [cameraState, decodeSource]);

  // Cameras come and go while the scanner is open (a webcam plugged in, a phone put in a dock), so keep the
  // list honest while it is running rather than offering a camera that has since gone.
  useEffect(() => {
    if (cameraState !== "on") return;
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const onChange = () => {
      media
        .enumerateDevices()
        .then((d) => setCameras(toCameraOptions(d)))
        .catch(() => {
          /* leave the list as it was */
        });
    };
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, [cameraState]);

  // Release the camera if the component unmounts while it is still running.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** Decode stills (phone photos, screenshots) through the same pipeline. Returns hit/miss counts. */
  const decodeFiles = useCallback(
    async (files: FileList | null): Promise<{ hits: number; misses: number }> => {
      let hits = 0;
      let misses = 0;
      for (const file of Array.from(files ?? [])) {
        try {
          const bitmap = await createImageBitmap(file);
          const hit = await decodeSource(bitmap);
          bitmap.close();
          if (hit) {
            onScanRef.current(hit.raw, hit);
            hits++;
          } else misses++;
        } catch {
          misses++;
        }
      }
      return { hits, misses };
    },
    [decodeSource],
  );

  /** Decode one picked area of the held frame, in the video's own pixel coordinates. Fires `onScan` on a hit,
   * and unlike the live loop it is never deduped - the pick itself is the intent, so re-picking the same code
   * reports it again. Returns the hit so the caller can say "nothing there" when the pick missed. */
  const decodeRegion = useCallback(
    async (region: Rect): Promise<Scan | null> => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return null;
      try {
        const hit = await decodeSource(video, region);
        if (!hit) return null;
        lastHitRef.current = { raw: hit.raw, at: Date.now() };
        onScanRef.current(hit.raw, hit);
        return hit;
      } catch {
        return null;
      }
    },
    [decodeSource],
  );

  return {
    videoRef,
    cameraState,
    startCamera,
    stopCamera,
    decodeFiles,
    frozen,
    freeze,
    unfreeze,
    attach,
    decodeRegion,
    cameras,
    cameraId,
    selectCamera,
    switchingCamera,
    zoomRange,
    zoom,
    setZoom: applyZoom,
  };
}

/** What `useCodeScanner` hands back - `ScanPreview` takes the whole thing. */
export type CodeScanner = ReturnType<typeof useCodeScanner>;
