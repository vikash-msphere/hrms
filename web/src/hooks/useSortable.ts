import { useCallback, useEffect, useRef, useState } from "react";

/** Where a drag would land: which list, and the gap to insert at (0 = before the first row). */
export type SortTarget = { container: string; index: number };

/** Drag-to-reorder for a list, built on POINTER events rather than HTML5 drag-and-drop.
 *
 *  The native `draggable` API is mouse-only: a touch never fires `dragstart` at all, and there is no keyboard
 *  equivalent. Since reordering is often the whole point of a panel (the dashboard's section list is used on a
 *  phone more than anywhere), a list whose only reorder gesture was a native drag would simply not be
 *  reorderable on the device it matters most on. Pointer events cover mouse, touch and pen in one path, and
 *  the grip is a real `<button>`, so arrow keys work without a second set of controls on screen.
 *
 *  Rows advertise themselves through one data attribute (`attr`), whose value is `"<container>|<index>"`, so
 *  hit-testing is `elementFromPoint` + `closest` with no element registry to keep in step with React's
 *  renders. A trailing `|end` marks a zone with no midpoint of its own - an empty list's placeholder - which
 *  always resolves to its stated index rather than to a before/after half.
 *
 *  `onDrop` receives the gap index measured against the list AS IT LOOKS NOW, so a caller moving a row DOWN
 *  within its own list must account for that row's own removal.
 */
export function useSortable(attr: string, onDrop: (id: string, target: SortTarget) => void) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<SortTarget | null>(null);
  // The committed target is read back inside the pointerup handler, which closes over the state value from
  // the render that installed it - so the live one rides a ref alongside.
  const live = useRef<SortTarget | null>(null);
  const cancelled = useRef(false);
  const setLive = (t: SortTarget | null) => { live.current = t; setTarget(t); };

  const locate = useCallback((x: number, y: number): SortTarget | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${attr}]`);
    const raw = el?.getAttribute(attr);
    if (!el || !raw) return null;
    const [container, rawIndex, end] = raw.split("|");
    const index = Number(rawIndex);
    if (!container || !Number.isFinite(index)) return null;
    if (end) return { container, index };
    const r = el.getBoundingClientRect();
    return { container, index: y - r.top > r.height / 2 ? index + 1 : index };
  }, [attr]);

  // Escape abandons the drag: the pointer is still down, so there is no other way to say "not this after all"
  // once a list has scrolled away under it.
  useEffect(() => {
    if (!dragId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      cancelled.current = true;
      setLive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragId]);

  /** Spread onto the grip: `{...start(id)}`. The grip needs `touch-action: none` (Tailwind `touch-none`) or a
   *  touch drag scrolls the page instead of moving the row. */
  const start = (id: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const el = e.currentTarget;
      // Capture, so the drag survives the pointer leaving the grip - which it does immediately.
      el.setPointerCapture(e.pointerId);
      cancelled.current = false;
      setDragId(id);
      setLive(null);
      const move = (ev: PointerEvent) => { if (!cancelled.current) setLive(locate(ev.clientX, ev.clientY)); };
      const end = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        const t = cancelled.current ? null : live.current;
        setDragId(null);
        setLive(null);
        if (t) onDrop(id, t);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    },
  });

  /** Spread onto a row: `{...slot(container, index)}`; `end` for a placeholder that stands for a whole gap. */
  const slot = (container: string, index: number, end?: boolean) => ({
    [attr]: `${container}|${index}${end ? "|end" : ""}`,
  });

  return { dragId, target, start, slot };
}
