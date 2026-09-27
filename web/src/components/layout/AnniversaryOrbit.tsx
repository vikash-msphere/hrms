import { useId } from "react";
import type { CSSProperties } from "react";

// The sidebar's company-anniversary treatment (anniversary.html, option 5a): a tilted orbit round the org's
// mark, a comet that runs the orbit and passes BEHIND the mark on the far side, a slow halo, and a caption
// that rolls between "<n> YEARS IN ORBIT" and "LAUNCHED <date>". Shown while the anniversary is inside the
// org's celebration lead time (Sidebar.tsx#Brand).
//
// Nothing here is a picture of one company's logo. The mark stays the org's own upload - the square logo or
// the wordmark - and this draws around it, so the design works for whatever the org has set in Name &
// branding. It assumes what the sidebar's brand slot gives it: a 36px-tall mark whose symbol is the first
// 36px from the left, with 16px of padding round it (the 255x68 box the design was drawn for).
//
// Colours come from the brand ramps via the `--anniv-*` tokens in index.css, one set per theme.

// The orbit, in the design's 68x68 box. The design's comet path is exactly this ellipse (fitted to within
// 0.002px), so it is stated as five numbers instead of 113 points.
const CX = 34;
const CY = 34;
const RX = 25;
const RY = 6.5;
const TILT = -22; // degrees; negative tilts the right end up

const rad = (TILT * Math.PI) / 180;
const fmt = (n: number) => n.toFixed(2);
// The two ends of the long axis. The orbit is drawn as two halves between them so the far half can sit
// behind the mark and the near half in front of it.
const RIGHT = { x: CX + RX * Math.cos(rad), y: CY + RX * Math.sin(rad) };
const LEFT = { x: CX - RX * Math.cos(rad), y: CY - RX * Math.sin(rad) };
const arcTo = (p: { x: number; y: number }) => `A${RX} ${RY} ${TILT} 0 1 ${fmt(p.x)} ${fmt(p.y)}`;
// Clockwise on screen from the right end: the near (lower) half first, then the far half over the top.
const NEAR_ARC = `M${fmt(RIGHT.x)} ${fmt(RIGHT.y)} ${arcTo(LEFT)}`;
const FAR_ARC = `M${fmt(LEFT.x)} ${fmt(LEFT.y)} ${arcTo(RIGHT)}`;
// The comet's track: the whole loop, starting on the near half. The z-index keyframes in index.css switch
// it behind the mark at exactly 50%, which is where this path crosses onto the far half.
const COMET_PATH = `path("${NEAR_ARC} ${arcTo(RIGHT)} Z")`;

// Seven tail dots growing and brightening towards the head, each a step behind the one in front.
const TAIL = Array.from({ length: 7 }, (_, i) => ({ size: 1.45 + 0.25 * i, opacity: ((i + 1) * 3) / 32 }));
const delay = (i: number) => `${-(2.4 + 0.07 * i).toFixed(2)}s`;

function Ring({ id, d, peak, edge, width, className }: { id: string; d: string; peak: number; edge: number; width: number; className: string }) {
  const stop = (offset: number, opacity: number) => (
    <stop offset={offset} style={{ stopColor: "hsl(var(--anniv-ring))", stopOpacity: opacity }} />
  );
  return (
    <svg className={className} viewBox="0 0 68 68" aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={fmt(LEFT.x)} y1={fmt(LEFT.y)} x2={fmt(RIGHT.x)} y2={fmt(RIGHT.y)}>
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
 */
export function AnniversaryOrbit() {
  const uid = useId().replace(/:/g, "");
  return (
    <div className="org-anniv org-anniv__orbit" aria-hidden="true">
      <div className="org-anniv__halo" />
      <Ring id={`anniv-far-${uid}`} d={FAR_ARC} peak={0.35} edge={0.2} width={0.7} className="org-anniv__ring org-anniv__ring--far" />
      <Ring id={`anniv-near-${uid}`} d={NEAR_ARC} peak={0.95} edge={0.12} width={0.8} className="org-anniv__ring org-anniv__ring--near" />
      {TAIL.map((t, i) => (
        <span key={i} className="org-anniv__dot" style={{ offsetPath: COMET_PATH, width: t.size, height: t.size, opacity: t.opacity, animationDelay: delay(i) } as CSSProperties} />
      ))}
      <span className="org-anniv__dot org-anniv__dot--head" style={{ offsetPath: COMET_PATH, width: 3.6, height: 3.6, animationDelay: delay(TAIL.length) } as CSSProperties} />
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
 * The rolling caption under the mark, bottom-right of the brand slot. Render it in the slot itself (made
 * `relative`), not in the mark's box. Left out of the collapsed icon rail, which has no room for it.
 */
export function AnniversaryCaption({ years, incorporationDate }: { years: number; incorporationDate: string }) {
  const launched = launchLabel(incorporationDate);
  const yearsText = `${years} ${years === 1 ? "YEAR" : "YEARS"}`;
  return (
    <div className="org-anniv org-anniv__cap" aria-label={launched ? `${yearsText.toLowerCase()} in orbit. Launched ${launched}` : `${yearsText.toLowerCase()} in orbit`}>
      <div className="org-anniv__row org-anniv__row--a" aria-hidden="true"><b>{yearsText}</b><span>IN ORBIT</span></div>
      {launched && <div className="org-anniv__row org-anniv__row--b" aria-hidden="true"><span>LAUNCHED</span><b>{launched}</b></div>}
    </div>
  );
}
