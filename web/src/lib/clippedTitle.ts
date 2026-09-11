/**
 * Gives clipped text its full text back, as a hover tooltip.
 *
 * `truncate` and `line-clamp-N` are everywhere in this UI, and that is the right call: a name column, a card
 * title, a ticket subject and a goal have to hold a fixed shape whatever the data does. What they cost is the
 * end of the sentence - an ellipsis says "there is more" and then offers no way to read it.
 *
 * The fix cannot be per-site. Whether a given box clips is a fact about the RUNNING LAYOUT (the string, the
 * font, the viewport, the user's column widths), not about the class list, so "add a title where the text is
 * long" is unanswerable in the source: the same cell clips on a phone and fits on a desktop. Nor is it a fact
 * anyone can keep up to date - every new `truncate` would have to remember to opt in. So this measures the
 * rendered tree instead, and the answer stays correct when the window is dragged.
 *
 * What it does: find the elements that CSS actually clips (`text-overflow: ellipsis`, or a `-webkit-line-clamp`),
 * measure whether the content overflows the box right now, and set `title` to the full text while it does -
 * removing it again the moment the box grows enough to show everything. `title` rather than the styled
 * <Tooltip>: a native tooltip is free of layout, needs no wrapper element and no per-row Radix root, and this
 * runs over every clipped box on the page at once.
 *
 * Deliberately NOT touched:
 * - anything already inside a <TooltipTrigger> (`data-tooltip-trigger`), which would otherwise pop the styled
 *   tooltip and a native one over each other on the same hover;
 * - an element that carries a `title` this module did not write - that sentence was chosen by a human and says
 *   something the text does not;
 * - form controls, whose scroll geometry is about the caret rather than about clipping.
 */

/** Marks a `title` this module owns, so a hand-written one is never overwritten or removed. */
const OWNED = "data-clipped-title";

/**
 * The pool to measure. Broad on purpose: it has to catch `truncate` and `line-clamp-2` written directly, and
 * the arbitrary variants (`[&>span]:truncate` on a <SelectTrigger>) where the CLASS sits on the parent and the
 * clipping lands on the child - hence the direct children of every hit. Nothing here decides anything; the
 * computed style does, in `clipAxis`.
 */
const POOL = '[class*="truncate"],[class*="line-clamp"],[class*="ellipsis"]';

/** Which way this element clips, per the cascade - `null` when it does not clip at all. */
function clipAxis(el: HTMLElement): "x" | "y" | null {
  const cs = getComputedStyle(el);
  // `line-clamp-none` resolves to "none" here, which is exactly why the class name is not trusted.
  if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") return "y";
  if (cs.textOverflow === "ellipsis" && cs.overflowX !== "visible") return "x";
  return null;
}

/** Whether the content is overflowing its box right now. 1px of slack: sub-pixel layout rounds either way. */
function overflowing(el: HTMLElement, axis: "x" | "y"): boolean {
  return axis === "x" ? el.scrollWidth - el.clientWidth > 1 : el.scrollHeight - el.clientHeight > 1;
}

function skip(el: HTMLElement): boolean {
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  // A styled tooltip already owns this hover.
  return !!el.closest("[data-tooltip-trigger]");
}

const tracked = new Set<HTMLElement>();
const dirty = new Set<HTMLElement>();
/** Cached `clipAxis`, invalidated when the element's class or style changes. Reading it is the expensive part. */
const axes = new WeakMap<HTMLElement, "x" | "y" | null>();
let frame: number | undefined;

function schedule(): void {
  if (frame !== undefined) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    flush();
  });
}

let ro: ResizeObserver | undefined;

function track(el: HTMLElement): void {
  if (!tracked.has(el)) {
    tracked.add(el);
    ro?.observe(el);
  }
  dirty.add(el);
}

/** Every element in `root` worth measuring, including `root` itself. */
function collect(root: ParentNode): void {
  if (root instanceof HTMLElement && root.matches(POOL)) {
    track(root);
    for (const child of root.children) if (child instanceof HTMLElement) track(child);
  }
  for (const el of root.querySelectorAll<HTMLElement>(POOL)) {
    track(el);
    for (const child of el.children) if (child instanceof HTMLElement) track(child);
  }
}

function apply(el: HTMLElement): void {
  const owned = el.hasAttribute(OWNED);
  // A hand-written title outranks anything measured here.
  if (el.hasAttribute("title") && !owned) return;

  let axis = axes.get(el);
  if (axis === undefined) {
    axis = clipAxis(el);
    axes.set(el, axis);
  }
  // `clientWidth === 0` is an unrendered box (a closed panel, a virtualised row): nothing to measure yet, and
  // it would measure as "not overflowing" and drop a title that is still correct.
  const show =
    axis !== null && el.clientWidth > 0 && overflowing(el, axis) && !skip(el)
      ? (el.textContent ?? "").replace(/\s+/g, " ").trim()
      : "";

  if (show) {
    if (el.getAttribute("title") !== show) el.setAttribute("title", show);
    if (!owned) el.setAttribute(OWNED, "");
  } else if (owned) {
    el.removeAttribute("title");
    el.removeAttribute(OWNED);
  }
}

function flush(): void {
  // Drop what React has unmounted, so neither the observer nor this set pins a detached tree in memory.
  for (const el of tracked) {
    if (!el.isConnected) {
      ro?.unobserve(el);
      tracked.delete(el);
      dirty.delete(el);
    }
  }
  for (const el of dirty) if (el.isConnected) apply(el);
  dirty.clear();
}

/**
 * Start measuring. Called once from the shell.
 *
 * Three things change the answer, and each has its own watcher: the box resizes (a window drag, a column
 * resize, a sidebar opening - `ResizeObserver`, per element, so a table of 500 rows does not re-measure
 * because one cell moved), the tree or the text changes (a route render, a filter, data arriving -
 * `MutationObserver`), or the font finally loads and every string re-measures at its real width.
 *
 * Writes are `title` only, which the class/style attribute filter deliberately does not watch - otherwise
 * each write would wake the observer that caused it.
 */
export function startClippedTitles(): void {
  if (typeof window === "undefined" || tracked.size > 0 || ro) return;

  ro = new ResizeObserver((entries) => {
    for (const e of entries) dirty.add(e.target as HTMLElement);
    schedule();
  });

  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") {
        const parent = r.target.parentElement;
        if (parent) dirty.add(parent);
      } else if (r.type === "attributes") {
        // Only this element, never a subtree query: a class toggle on a page-level container is a common
        // mutation, and re-walking the page for each one is how a watcher like this becomes the slow thing.
        const el = r.target as HTMLElement;
        axes.delete(el);
        if (tracked.has(el)) dirty.add(el);
        else if (el.matches(POOL)) {
          track(el);
          for (const child of el.children) if (child instanceof HTMLElement) track(child);
        }
      } else {
        for (const node of r.addedNodes) if (node instanceof HTMLElement) collect(node);
        // A removed subtree is reaped in `flush` by `isConnected`, which also covers the nodes React moves.
        // Text swapped in as a whole node under an element that is itself the clipped box.
        if (r.target instanceof HTMLElement && tracked.has(r.target)) dirty.add(r.target);
      }
    }
    schedule();
  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  collect(document.body);
  schedule();

  // Text laid out in the fallback font measures at the wrong width, so the first answer can be wrong in both
  // directions until Inter is in.
  void document.fonts?.ready.then(() => {
    for (const el of tracked) dirty.add(el);
    schedule();
  });
}
