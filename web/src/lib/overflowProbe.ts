/**
 * Dev-only: names the box that is wider than the screen.
 *
 * `html { overflow-x: clip }` (index.css) is a backstop, and it works: the document never scrolls sideways.
 * The cost of that is diagnostic, not visual - the offending box is clipped rather than scrolled, so the
 * symptom a reader reports is "the page overflows the screen" with nothing on the page to point at. Reading
 * the source to find it does not scale either: a box is over-wide because of what its CONTENT does at one
 * particular width, which is a fact about the running layout and not about any one class list.
 *
 * So this measures. It walks the rendered tree, keeps every element painting past the viewport, discards the
 * ones that are inside a declared scroller (a kanban board, a roster grid, a wide table - those are allowed
 * to be wide, see docs/06-responsive-ui.md rule 19), and reports the DEEPEST of what is left: an over-wide
 * leaf makes every ancestor over-wide too, and the ancestors are consequences rather than causes.
 *
 * Off unless asked for, and never in a production bundle: `?overflow=1` on any URL turns it on for the
 * session (`?overflow=0` off again), and it prints to the console plus a small readout in the corner so the
 * answer is legible on a phone, where there is no console to open.
 */

type Offender = {
  el: HTMLElement;
  /** How far past the viewport's right edge the box paints, in CSS px (negative left counts too). */
  over: number;
  width: number;
};

const FLAG = "hrms:overflow-probe";

/** `?overflow=1` arms it and is remembered, so a reload or a navigation keeps measuring. */
function armed(): boolean {
  if (!import.meta.env.DEV) return false;
  const q = new URLSearchParams(location.search).get("overflow");
  if (q === "1") localStorage.setItem(FLAG, "1");
  if (q === "0") localStorage.removeItem(FLAG);
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return q === "1"; // private mode: still usable for one page view
  }
}

/**
 * Whether being over-wide is fine here. Three excuses, and each one is a claim worth stating:
 *
 * - Inside a box that clips or scrolls horizontally: that is exactly what a wide surface is REQUIRED to say
 *   for itself (a kanban board, a roster grid, a wide table). `html`'s own clip is deliberately NOT counted -
 *   leaning on that backstop is the bug this looks for.
 * - Fixed, or inside something fixed: the app bar, the bottom nav and the off-canvas drawer are positioned
 *   against the viewport, and the drawer is translated clear of it on purpose.
 * - `sr-only`: a screen-reader-only table measures wide because a table cannot shrink below its min-content
 *   (it ignores the `width: 1px`), while `clip: rect(0,0,0,0)` paints none of it.
 */
function excused(el: HTMLElement): boolean {
  for (let p: HTMLElement | null = el; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.position === "fixed") return true;
    if (cs.clip === "rect(0px, 0px, 0px, 0px)") return true;
    if (p !== el && cs.overflowX !== "visible") return true;
  }
  return false;
}

/** A short, readable identity for one element: what a reader can grep for. */
function describe(el: HTMLElement): string {
  const cls = el.getAttribute("class");
  const id = el.id ? `#${el.id}` : "";
  return `<${el.tagName.toLowerCase()}${id}${cls ? ` class="${cls.slice(0, 160)}"` : ""}>`;
}

function scan(): Offender[] {
  // The viewport, not the document: the document may be wider, and that is exactly what is being measured.
  const limit = document.documentElement.clientWidth;
  const found: Offender[] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const over = Math.max(r.right - limit, -r.left);
    if (over <= 1 || excused(el)) continue;
    found.push({ el, over, width: r.width });
  }
  // An over-wide box widens every ancestor, so the ancestors are noise. Keep the ones with no offender
  // inside them - those are the boxes whose own content is too wide, which is where a fix goes.
  const deepest = found.filter((f) => !found.some((o) => o !== f && f.el.contains(o.el)));
  return deepest.sort((a, b) => b.over - a.over);
}

/** The corner readout. Fixed and clamped, so the probe can never be the thing that overflows. */
function paint(list: Offender[]): void {
  let box = document.getElementById("overflow-probe") as HTMLDivElement | null;
  if (!list.length) {
    box?.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.id = "overflow-probe";
    box.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:calc(100vw - 16px);max-height:40vh;overflow:auto;" +
      "padding:8px 10px;border-radius:8px;background:#7f1d1d;color:#fff;font:11px/1.45 ui-monospace,monospace;" +
      "word-break:break-all;box-shadow:0 4px 16px rgba(0,0,0,.4)";
    box.title = "Boxes wider than the viewport (dev only). Tap to log the full list; ?overflow=0 to turn off.";
    box.onclick = () => console.log("[overflow]", list.map((o) => o.el));
    document.body.appendChild(box);
  }
  const lines = list
    .slice(0, 4)
    .map((o) => `+${Math.round(o.over)}px  ${Math.round(o.width)}px wide\n${describe(o.el)}`)
    .join("\n\n");
  box.textContent = `${list.length} box${list.length === 1 ? "" : "es"} past the viewport\n\n${lines}`;
}

function report(): void {
  const list = scan();
  paint(list);
  if (!list.length) {
    console.info("[overflow] nothing past the viewport");
    return;
  }
  console.groupCollapsed(`[overflow] ${list.length} box(es) wider than the viewport`);
  for (const o of list) {
    console.log(`+${Math.round(o.over)}px past the edge, ${Math.round(o.width)}px wide`, o.el, describe(o.el));
  }
  console.groupEnd();
}

/**
 * Start measuring. Called once from the shell; a no-op unless armed.
 *
 * Re-measures on the three things that change the answer: the viewport (resize, rotate), the tree (a route
 * render, a filter, data arriving) and a manual `window.overflowProbe()` from the console. The tree watcher
 * is debounced because a React render is many mutations and a scan reads layout for every element.
 */
export function startOverflowProbe(): void {
  if (!armed()) return;
  let timer: number | undefined;
  const soon = () => {
    clearTimeout(timer);
    // Two frames past the last mutation: a scan mid-render measures boxes that are half laid out.
    timer = window.setTimeout(() => requestAnimationFrame(report), 250);
  };
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, attributes: true });
  addEventListener("resize", soon);
  addEventListener("orientationchange", soon);
  (window as unknown as { overflowProbe: () => void }).overflowProbe = report;
  soon();
  console.info("[overflow] probe armed - ?overflow=0 to stop, window.overflowProbe() to re-measure");
}
