import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMedia } from "@/hooks/useMedia";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
// A sheet is a modal layer like a dialog, so Back closes it rather than leaving the page - see
// hooks/useHistoryClose.ts, and the `routed` prop below for the one sheet that owns a route entry already.
import { HistoryClose } from "@/hooks/useHistoryClose";

// A large overlay working surface. Same Radix a11y machinery as dialog.tsx (focus trap, Esc, scroll lock,
// portal), sized for real panels rather than a small modal. This is the single presentation for inline
// settings: roomy enough for the big ones (Letters, Pay components, ATS) and fine for the small ones, so
// there is no branch-by-size.
//
// Two geometries, because a 760px right-docked panel on a 390px screen is just a screen with an unreachable
// close button in the top corner: a phone gets a bottom sheet (grabber, drag-to-dismiss, keyboard-aware),
// everything from `sm` up keeps the right-docked panel.
//
// A third, opted into with `<Sheet dock>`, for a record's detail opened from a list: on a wide screen the panel
// sits BESIDE the list instead of over it (docs/06-responsive-ui.md, "Wide screens"). It is non-modal there - no
// overlay, no focus trap, no scroll lock - it starts under the top bar, and the page column below the bar gives
// up the panel's width (`--sheet-dock`, read in App.tsx), so the list re-centres in what is left rather than
// being covered. A click outside does not close it, which is what lets a click on another row swap the detail;
// its close button, Back, and Escape pressed from inside it still do. Below DOCK_QUERY it is the ordinary modal
// sheet, unchanged.
//
// 1920px is `3xl` in web/src/index.css: where a list keeps about the width a 1440 screen gives it with a
// 32rem panel beside it. Change the two together.
const DOCK_QUERY = "(min-width: 1920px)";
const SheetDockContext = React.createContext(false);

function Sheet({ dock, modal, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> & { dock?: boolean }) {
  const wide = useMedia(DOCK_QUERY);
  const docked = !!dock && wide;
  return (
    <SheetDockContext.Provider value={docked}>
      <DialogPrimitive.Root {...props} modal={docked ? false : modal} />
    </SheetDockContext.Provider>
  );
}
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    // Exits AFTER the panel (400ms against SheetContent's 300), so a sheet reopened mid-exit never gets its
    // backdrop portaled over it - see DialogOverlay in ui/dialog.tsx.
    className={cn(
      "fixed inset-0 z-50 bg-overlay backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-[400ms] data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = "SheetOverlay";

// Drag-to-dismiss for the phone bottom sheet. A downward drag from the grabber (or from the header, which is
// the whole top edge and what a thumb actually lands on) follows the finger and, past a threshold, closes.
//
// Closing dispatches Escape at the content node rather than calling the caller's setState - the same route
// dialog.tsx takes, and the reason is the same: every sheet then closes through the path it already owns,
// including any unsaved-changes guard hanging off onOpenChange.
function useDragDismiss(node: HTMLElement | null, enabled: boolean) {
  const start = React.useRef<number | null>(null);
  const dragged = React.useRef(0);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled || e.pointerType === "mouse") return;
    start.current = e.clientY;
    dragged.current = 0;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (start.current == null || !node) return;
    // Downward only: an upward pull on a sheet that is already at its ceiling should do nothing, not stretch.
    const dy = Math.max(0, e.clientY - start.current);
    dragged.current = dy;
    node.style.transition = "none";
    node.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (start.current == null || !node) return;
    start.current = null;
    const far = dragged.current > 120;
    node.style.transition = "transform 200ms ease";
    node.style.transform = far ? "translateY(100%)" : "";
    if (far) node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  };
  return enabled ? { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end } : {};
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    // Set when the sheet's open state lives in the URL (the inline settings sheet, keyed on `?setting=`).
    // Opening it already pushed a route entry, so Back closes it without any help from here; pushing a second
    // entry would make one panel cost two back presses.
    routed?: boolean;
  }
>(({ className, children, style, routed, onInteractOutside, onEscapeKeyDown, ...props }, ref) => {
  const [node, setNode] = React.useState<HTMLDivElement | null>(null);
  const docked = React.useContext(SheetDockContext);
  // The width the page column gives up while a docked sheet is open: measured rather than restated, so a caller's
  // own `sm:max-w-*` is what the list makes room for. Removed when the panel unmounts, after its exit animation.
  React.useEffect(() => {
    if (!docked || !node) return;
    const root = document.documentElement;
    const reserve = () => root.style.setProperty("--sheet-dock", `${node.offsetWidth}px`);
    reserve();
    const ro = new ResizeObserver(reserve);
    ro.observe(node);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--sheet-dock");
    };
  }, [docked, node]);
  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      setNode(el);
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [ref],
  );
  // A phone gets the bottom sheet; a tablet and up keeps the right-docked panel. Matched in JS as well as CSS
  // because the drag gesture only belongs to the bottom form - dragging a side panel downwards means nothing.
  const phone = useMedia("(max-width: 639px)");
  const keyboard = useKeyboardInset();
  const drag = useDragDismiss(node, phone);
  return (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={setRefs}
      // Phone: a sheet rising from the bottom edge, stopping short of the top so the page stays visible behind
      // it (that strip is what makes it read as a layer over the page rather than a new screen), with rounded
      // top corners and a grabber. It gives up height to the keyboard exactly like a dialog does.
      // sm and up: unchanged - a full-height panel docked to the right, sized for real working surfaces.
      className={cn(
        // The side insets are the landscape notch - it covers the edge a full-bleed bottom sheet runs to,
        // and (from `sm`, docked right) the edge the panel is pinned against.
        "fixed inset-x-0 bottom-0 z-50 flex max-h-[calc(100dvh-2.5rem-var(--kb,0px))] flex-col rounded-t-2xl border bg-card pl-safe-l pr-safe-r shadow-xl duration-300",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        "sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:h-full sm:max-h-none sm:w-full sm:max-w-[760px] sm:rounded-none sm:border-l",
        "sm:data-[state=closed]:slide-out-to-right sm:data-[state=open]:slide-in-from-right",
        className,
        // Docked: below the top bar (h-14) rather than over it, and flat - it is part of the layout now, edged by
        // its border, not a layer floating over the page.
        docked && "sm:top-14 sm:h-auto sm:shadow-none",
      )}
      style={{ ...(style ?? {}), ...(keyboard ? ({ "--kb": `${keyboard}px` } as React.CSSProperties) : {}) }}
      onInteractOutside={(e) => {
        onInteractOutside?.(e);
        // A click on the list beside a docked panel is the reader picking another row, not dismissing the panel.
        if (docked) e.preventDefault();
      }}
      onEscapeKeyDown={(e) => {
        onEscapeKeyDown?.(e);
        // Escape typed in the list (its search box, a row menu) belongs to the list. Pressed inside the panel, or
        // dispatched at it (the phone drag, Back's fallback), it closes the panel as it always has.
        if (docked && !(e.target instanceof Node && node?.contains(e.target))) e.preventDefault();
      }}
      {...props}
    >
      {phone && (
        // The grabber. Also the drag surface: 44px of dead space at the top edge is where a thumb reaches
        // first, and the visual bar is the only thing that says the gesture exists.
        <div
          {...drag}
          className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-t-2xl active:cursor-grabbing"
          aria-hidden
        >
          <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
        </div>
      )}
      {/* Inside the content element, so the entry belongs to this OPENING - see hooks/useHistoryClose.ts. */}
      <HistoryClose node={node} enabled={!routed} />
      <SheetDragContext.Provider value={phone ? drag : EMPTY_DRAG}>{children}</SheetDragContext.Provider>
    </DialogPrimitive.Content>
  </SheetPortal>
  );
});
SheetContent.displayName = DialogPrimitive.Content.displayName;

// Lets SheetHeader join the drag surface without every caller wiring handlers through.
type DragHandlers = Partial<Pick<React.DOMAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">>;
const EMPTY_DRAG: DragHandlers = {};
const SheetDragContext = React.createContext<DragHandlers>(EMPTY_DRAG);

// Sticky top bar. Carries a built-in close button so callers only supply the title/description/access affordance.
const SheetHeader = ({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  const drag = React.useContext(SheetDragContext);
  return (
  <div
    // The header is part of the drag handle on a phone (see SheetContent). `touch-none` only where the gesture
    // is claimed, so on a desktop the header keeps normal text selection.
    {...drag}
    className={cn(
      "sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-card px-4 py-3 sm:px-6 sm:py-4",
      drag.onPointerDown && "touch-none",
      className,
    )}
    {...props}
  >
    <div className="min-w-0 flex-1">{children}</div>
    {/* A finger-sized close box around a 16px glyph - the previous target was the glyph itself. */}
    <DialogPrimitive.Close data-history-close="" className="-mr-1.5 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:bg-accent hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring">
      <X className="h-4 w-4" />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  </div>
  );
};
SheetHeader.displayName = "SheetHeader";

// The scrolling region between the sticky header and footer.
const SheetBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5", className)} {...props} />
);
SheetBody.displayName = "SheetBody";

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    // pb-safe: docked to the bottom edge of a phone, the actions would otherwise sit under the home indicator.
    className={cn(
      "sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t bg-card px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-3",
      className,
    )}
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-tight tracking-tight", className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("mt-0.5 text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
