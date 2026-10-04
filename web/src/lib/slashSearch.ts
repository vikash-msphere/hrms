import { useEffect, useState } from "react";

// `/` puts the cursor in a search box - the shortcut the help sheet lists as "Search within the page" - and the
// box it reaches says so in its placeholder ("Search (/) people…"), because a key nothing on screen names is a
// key nobody finds. Every search box is a SearchInput (components/common/SearchInput.tsx), which registers
// here, and one listener answers the key for all of them.
//
// Which box: the first visible one, in document order, inside the topmost open overlay - a dialog, sheet or
// popover owns the keyboard while it is up - or on the page itself when nothing is open. A FALLBACK box (the
// settings rail's search, which sits beside every settings section) is reached only when its scope shows no
// other box, so a section's own search wins over the rail. Each box works out whether it is the one for its
// own scope, so the hint is only shown where `/` actually lands.

const OVERLAY = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
// An open select or dropdown menu types ahead on its own keys, `/` included.
const MENU = '[role="listbox"][data-state="open"], [role="menu"][data-state="open"]';

/** Each registered box, and whether it is a fallback. */
const boxes = new Map<HTMLInputElement, boolean>();
const listeners = new Set<() => void>();

// Batched to one recompute a frame, after the mount or resize that asked for it has been laid out.
let frame = 0;
function changed() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    listeners.forEach((on) => on());
  });
}

const scopeOf = (el: Element): Element | null => el.closest(OVERLAY);

/** The box `/` reaches in `scope` (null: the page outside every overlay). */
function targetIn(scope: Element | null): HTMLInputElement | null {
  let first: HTMLInputElement | null = null;
  let firstFallback: HTMLInputElement | null = null;
  const before = (a: HTMLInputElement, b: HTMLInputElement | null) => !b || !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
  for (const [el, fallback] of boxes) {
    // No client rects: hidden, in an inactive tab panel or under a closed breakpoint.
    if (scopeOf(el) !== scope || el.getClientRects().length === 0) continue;
    if (fallback) {
      if (before(el, firstFallback)) firstFallback = el;
    } else if (before(el, first)) first = el;
  }
  return first ?? firstFallback;
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.isComposing) return;
  const t = e.target as HTMLElement | null;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  if (document.querySelector(MENU)) return;
  const overlays = document.querySelectorAll(OVERLAY);
  const box = targetIn(overlays[overlays.length - 1] ?? null);
  if (!box) return;
  e.preventDefault();
  box.focus();
  box.select();
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKey);
  // A breakpoint can hide one box and show another without either of them mounting.
  window.addEventListener("resize", changed);
}

/** Registers `el` as a `/` target (a `fallback` one yields to any other box in its scope). True while it is the
 *  box `/` reaches in its own scope. */
export function useSlashTarget(el: HTMLInputElement | null, fallback = false): boolean {
  const [reachable, setReachable] = useState(false);
  useEffect(() => {
    if (!el) return;
    install();
    const check = () => setReachable(targetIn(scopeOf(el)) === el);
    boxes.set(el, fallback);
    listeners.add(check);
    changed();
    return () => {
      boxes.delete(el);
      listeners.delete(check);
      changed();
    };
  }, [el, fallback]);
  return reachable;
}

/** `placeholder` with the `/` hint after its leading verb ("Search (/) people…"), or at the end without one. */
export function withSlashHint(placeholder: string): string {
  const hinted = placeholder.replace(/^(search|filter|find)\b/i, "$& (/)");
  return hinted === placeholder ? `${placeholder} (/)` : hinted;
}
