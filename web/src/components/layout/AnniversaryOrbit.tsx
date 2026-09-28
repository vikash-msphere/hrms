import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

// The sidebar's company-anniversary treatment (anniversary.html, option 5a): a tilted orbit round the org's
// mark, a comet that runs the orbit and passes BEHIND the mark on the far side, a slow halo, and a caption
// that rolls between "<n> YEARS IN ORBIT" and "LAUNCHED <date>". Shown while the anniversary is inside the
// org's celebration lead time (Sidebar.tsx#Brand).
//
// Nothing here is a picture of one company's logo. The mark stays the org's own upload - the square logo or
// the wordmark - and this draws around it, so the design works for whatever the org has set in Name &
// branding. The design was drawn for a 36px-tall mark whose symbol is its first 36px from the left, with the
// orbit's box reaching 16px past it on every side (the 255x68 slot). The mark is not always that size - in
// the phone drawer the close button narrows the slot and the wordmark comes out about 28px tall - so the
// orbit measures the mark's box and scales to it.
//
// Colours come from the brand ramps via the `--anniv-*` tokens in index.css, one set per theme.

// The orbit, in the design's units: a 68x68 box round a 36px mark. The design's comet path is exactly this
// ellipse (fitted to within 0.002px), so it is stated as five numbers instead of 113 points.
const MARK = 36;
const BOX = 68;
const CX = 34;
const CY = 34;
const RX = 25;
const RY = 6.5;
const TILT = -22; // degrees; negative tilts the right end up

const rad = (TILT * Math.PI) / 180;
const fmt = (n: number) => n.toFixed(2);
type Pt = { x: number; y: number };

// The orbit's paths at scale `s` (1 = the design's 36px mark). The two halves run between the ends of the long
// axis, so the far half can sit behind the mark and the near half in front of it.
function orbitPaths(s: number) {
  const right: Pt = { x: (CX + RX * Math.cos(rad)) * s, y: (CY + RX * Math.sin(rad)) * s };
  const left: Pt = { x: (CX - RX * Math.cos(rad)) * s, y: (CY - RX * Math.sin(rad)) * s };
  const arcTo = (p: Pt) => `A${fmt(RX * s)} ${fmt(RY * s)} ${TILT} 0 1 ${fmt(p.x)} ${fmt(p.y)}`;
  // Clockwise on screen from the right end: the near (lower) half first, then the far half over the top.
  const near = `M${fmt(right.x)} ${fmt(right.y)} ${arcTo(left)}`;
  const far = `M${fmt(left.x)} ${fmt(left.y)} ${arcTo(right)}`;
  // The comet's track: the whole loop, starting on the near half. The z-index keyframes in index.css switch
  // it behind the mark at exactly 50%, which is where this path crosses onto the far half.
  return { left, right, near, far, comet: `path("${near} ${arcTo(right)} Z")` };
}
// The rings are drawn in design units and scaled by their viewBox; only the comet's track, which is in CSS
// pixels, has to be rebuilt per scale.
const DESIGN = orbitPaths(1);

// Seven tail dots growing and brightening towards the head, each a step behind the one in front.
const TAIL = Array.from({ length: 7 }, (_, i) => ({ size: 1.45 + 0.25 * i, opacity: ((i + 1) * 3) / 32 }));
const delay = (i: number) => `${-(2.4 + 0.07 * i).toFixed(2)}s`;

function Ring({ id, d, peak, edge, width, className }: { id: string; d: string; peak: number; edge: number; width: number; className: string }) {
  const stop = (offset: number, opacity: number) => (
    <stop offset={offset} style={{ stopColor: "hsl(var(--anniv-ring))", stopOpacity: opacity }} />
  );
  return (
    <svg className={className} viewBox={`0 0 ${BOX} ${BOX}`} aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={fmt(DESIGN.left.x)} y1={fmt(DESIGN.left.y)} x2={fmt(DESIGN.right.x)} y2={fmt(DESIGN.right.y)}>
          {stop(0, 0)}
          {stop(edge, peak)}
          {stop(1 - edge, peak)}
          {stop(1, 0)}
        </linearGradient>
      </defs>
      <path d={d} stroke={`url(#${id})`} strokeWidth={width} />
    </svg>
  );
}

/**
 * The orbit layer. Render it INSIDE the mark's own box, as a sibling of the mark image, with that box
 * `relative isolate` and the image `relative z-[1]`: the comet changes its z-index to pass behind and in
 * front of the image, which only works while the two share one stacking context.
 *
 * The orbit sizes itself to that box's height, which is the mark's (a block image fills it exactly).
 */
export function AnniversaryOrbit() {
  const uid = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    // Clamped so an image that has not loaded yet (0px) or an odd upload cannot collapse or balloon it.
    const measure = () => {
      const h = host.clientHeight;
      if (h > 0) setScale(Math.min(1.5, Math.max(0.5, h / MARK)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  const comet = useMemo(() => orbitPaths(scale).comet, [scale]);
  const box = BOX * scale;
  // The mark's top-left sits (BOX - MARK) / 2 design units in from the box's.
  const inset = -((BOX - MARK) / 2) * scale;
  return (
    <div ref={ref} className="org-anniv org-anniv__orbit" style={{ left: inset, top: inset, width: box, height: box }} aria-hidden="true">
      <div className="org-anniv__halo" />
      <Ring id={`anniv-far-${uid}`} d={DESIGN.far} peak={0.35} edge={0.2} width={0.7} className="org-anniv__ring org-anniv__ring--far" />
      <Ring id={`anniv-near-${uid}`} d={DESIGN.near} peak={0.95} edge={0.12} width={0.8} className="org-anniv__ring org-anniv__ring--near" />
      {TAIL.map((t, i) => (
        <span key={i} className="org-anniv__dot" style={{ offsetPath: comet, width: t.size * scale, height: t.size * scale, opacity: t.opacity, animationDelay: delay(i) } as CSSProperties} />
      ))}
      <span className="org-anniv__dot org-anniv__dot--head" style={{ offsetPath: comet, width: 3.6 * scale, height: 3.6 * scale, animationDelay: delay(TAIL.length) } as CSSProperties} />
    </div>
  );
}

// "2025-10-10" -> "10.10.25", the design's launch-date style. Read off the stored string, not a Date, so no
// timezone can move it a day.
function launchLabel(incorporationDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(incorporationDate.trim());
  return m ? `${m[3]}.${m[2]}.${m[1]!.slice(2)}` : null;
}

/**
 * The rolling caption, bottom-right. Two placements:
 *   "under-mark" - inside a wordmark's box, hung just below its right edge. The wordmark's height follows the
 *                  slot's width (it is shorter in the phone drawer), so a caption placed from the slot's top
 *                  would hang off the bottom of it; placed from the image, it follows the image.
 *   "slot"       - in the brand slot itself (made `relative`), for the square logo + name, whose row is always
 *                  the design's 68px.
 * Left out of the collapsed icon rail, which has no room for it.
 */
export function AnniversaryCaption({ years, incorporationDate, placement }: { years: number; incorporationDate: string; placement: "under-mark" | "slot" }) {
  const launched = launchLabel(incorporationDate);
  const yearsText = `${years} ${years === 1 ? "YEAR" : "YEARS"}`;
  return (
    <div className={`org-anniv org-anniv__cap org-anniv__cap--${placement}`} aria-label={launched ? `${yearsText.toLowerCase()} in orbit. Launched ${launched}` : `${yearsText.toLowerCase()} in orbit`}>
      <div className="org-anniv__row org-anniv__row--a" aria-hidden="true"><b>{yearsText}</b><span>IN ORBIT</span></div>
      {launched && <div className="org-anniv__row org-anniv__row--b" aria-hidden="true"><span>LAUNCHED</span><b>{launched}</b></div>}
    </div>
  );
}
