import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
// Back closes the topmost overlay, for dialogs and sheets alike - see hooks/useHistoryClose.ts.
import { HistoryClose } from "@/hooks/useHistoryClose";
// The keyboard measurement is shared with sheet.tsx and the command palette - see hooks/useKeyboardInset.ts for
// why a bottom-anchored phone panel cannot trust `bottom: 0`.
import { useKeyboardInset } from "@/hooks/useKeyboardInset";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    // The backdrop's exit OUTLASTS the panel's (300ms against DialogContent's 200). Radix portals the two
    // separately, each kept mounted only until its own exit animation ends, and they share a z-index - so DOM
    // order decides which paints on top. Reopened in the gap after a shorter-lived backdrop had gone but before
    // the panel had, the backdrop was portaled again at the END of <body>, over the panel still standing there:
    // the prompt sat blurred under its own backdrop and every click on it dismissed it instead. The shared
    // confirm does exactly that on every "delete, then re-apply the split?" pair. With the backdrop outliving the
    // panel, the only possible split is the panel re-portaled after it, which is the right way up.
    className={cn(
      "fixed inset-0 z-50 bg-overlay backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-300 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

// A dialog is a bottom sheet on a phone and a centred card from `sm` up. Same component, because the content
// is identical and only the geometry differs: a centred card on a 390px screen wastes the edges, puts its
// actions where no thumb reaches, and fights the on-screen keyboard.
//
// Two defaults are applied unless the caller says otherwise, so no dialog can push its own footer off screen:
// a viewport-relative max height, and vertical scrolling. Callers that own their scrolling (a flex column with
// an internal scroll area) set any `overflow-*` class and keep it - hence the regex rather than a class merge,
// which would leave `overflow-hidden overflow-y-auto` fighting in the stylesheet.
// Radix locks the page behind a modal layer by setting `pointer-events: none` on <body>, and lifts it when
// that layer closes. When a dialog is opened FROM another layer - the common row-menu -> "Edit" path - the
// menu's lock can outlive the dialog that replaced it, and the page is then dead to the mouse: every click
// lands on <html> and nothing responds until some later layer happens to close cleanly. So when the dialog
// closes, once no modal layer is left open, lift the lock. A no-op whenever Radix has already done it.
function useReleasePointerLock() {
  React.useEffect(
    () => () => {
      setTimeout(() => {
        if (document.querySelector('[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"], [data-state="open"][role="menu"]')) return;
        if (document.body.style.pointerEvents === "none") document.body.style.pointerEvents = "";
      }, 0);
    },
    [],
  );
}

// Everything that is owed to ONE OPENING of a dialog, mounted inside the content element so that it lives
// exactly as long as the opening does. `<Dialog open={false}><DialogContent/></Dialog>` mounts the wrapper
// below the moment its page renders - dialogs a reader has never opened and may never open - so a hook called
// out there fires on page load for every dialog the page declares. See hooks/useHistoryClose.ts.
function DialogLifecycle({ node }: { node: HTMLElement | null }) {
  useReleasePointerLock();
  return <HistoryClose node={node} />;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    // When set, pressing Enter in a single-line text input within the dialog runs this (the primary submit),
    // so dialogs are keyboard-completable without wrapping each in a <form>. Textareas, selects, file inputs
    // and buttons keep Enter for their own use - except with Cmd/Ctrl held, which submits from anywhere in the
    // dialog, so a form whose last field is a textarea (a reason, a note) is finishable without reaching for
    // the mouse. Callers should guard validity inside the handler.
    onEnterSubmit?: () => void;
    // Turns the panel into a flex column whose <DialogBody> scrolls on its own, leaving the header and footer
    // fixed. Use it for any form long enough to scroll: the alternative is a Save button that lives below the
    // fold, which on a phone means scrolling a ten-field form back down to find the action.
    scrollBody?: boolean;
    // The backdrop's classes. Only needed to lift a dialog above another one (see ConfirmProvider): portals
    // stack by mount order, so a dialog opened LAST paints on top regardless of who logically owns the screen.
    overlayClassName?: string;
  }
>(({ className, children, onEnterSubmit, onKeyDown, scrollBody, overlayClassName, style, ...props }, ref) => {
  // The content node is needed to aim the synthetic Escape at, and callers may still pass their own ref.
  const [node, setNode] = React.useState<HTMLDivElement | null>(null);
  const keyboard = useKeyboardInset();
  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      setNode(el);
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [ref],
  );
  return (
  <DialogPortal>
    <DialogOverlay className={overlayClassName} />
    <DialogPrimitive.Content
      ref={setRefs}
      className={cn(
        // Margin, not padding: the panel is inset from the screen on every side and keeps a normal p-6 inside.
        // Inflating the padding to fake breathing room only shrinks the usable width.
        // `--kb` is what the keyboard is covering (0 on desktop): the sheet sits above it and gives up the same
        // height, so the field in focus and the footer are both still on screen while typing.
        // A gutter rather than flush to the edges: a sheet with a gutter reads as a panel over the page, and
        // on a rounded screen the corners of a full-bleed one get clipped. The gutter carries the landscape
        // side insets, or a phone held sideways puts the panel's edge under the notch.
        // p-5 on a phone, p-6 from `sm`: a 360px screen gives the panel 328px, and 24px of padding either
        // side spends 15% of that on nothing. Four pixels back per side is a whole character of every label.
        "fixed bottom-[calc(0.5rem+var(--kb,0px))] left-[calc(1rem+env(safe-area-inset-left))] right-[calc(1rem+env(safe-area-inset-right))] z-50 mx-auto mb-[env(safe-area-inset-bottom)] max-h-[calc(100dvh-4rem-var(--kb,0px))] w-auto max-w-lg gap-5 rounded-2xl border bg-card p-5 shadow-lg duration-200 sm:p-6",
        scrollBody ? "flex flex-col overflow-hidden" : "grid",
        !scrollBody && !/(^|\s)overflow-/.test(className ?? "") && "overflow-y-auto",
        // Room to breathe on a big screen: a dialog pinned to 512px on a 1440px display scrolls for no reason
        // other than habit. Skipped entirely when the caller states its own width, so a deliberately narrow
        // dialog (a confirm, a small picker) stays narrow and a deliberately wide one keeps its own ceiling.
        !/(^|\s)(?:sm:|md:|lg:|xl:|2xl:)?max-w-/.test(className ?? "") && "sm:max-w-xl lg:max-w-2xl",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        // Centred from `sm` up, and never edge-to-edge: the width is 100% MINUS a gutter, so a dialog whose
        // max-width is wider than the window (a 2xl form in a 700px browser, a split screen, a phone in
        // landscape) still has room either side instead of touching both edges. The max-w above still caps it.
        "sm:inset-x-auto sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:mb-0 sm:w-[calc(100%-3rem)] sm:translate-x-[-50%] sm:translate-y-[-50%]",
        "sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
        className
      )}
      style={{ ...(style ?? {}), ...(keyboard ? ({ "--kb": `${keyboard}px` } as React.CSSProperties) : {}) }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!onEnterSubmit || e.key !== "Enter" || e.shiftKey || e.defaultPrevented) return;
        const el = e.target as HTMLElement;
        const fromInput = el.tagName === "INPUT" && (el as HTMLInputElement).type !== "file";
        if (fromInput || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onEnterSubmit();
        }
      }}
      {...props}
    >
      {children}
      <DialogLifecycle node={node} />
      <DialogPrimitive.Close data-history-close="" className="absolute right-4 top-4 rounded-sm opacity-60 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

// The scrolling middle of a `scrollBody` dialog. The negative margin plus matching padding lets a focus ring
// on an edge control breathe instead of being clipped by the scroll container.
const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("-mx-5 grid min-h-0 flex-1 gap-5 overflow-y-auto overscroll-contain px-5 sm:-mx-6 sm:px-6", className)} {...props} />
);
DialogBody.displayName = "DialogBody";

// Reversed column on a phone, a plain row from `sm` up.
//
// Reversed, so the LAST action in the markup (the primary - Save, Confirm) sits at the top of the stack and
// Cancel ends up at the bottom edge. That is the action-sheet convention: the bottom of a bottom-anchored
// sheet is where a thumb rests, so the thing that sits there should be the harmless one. Markup order is
// unchanged (Cancel then Save), which keeps tab and screen-reader order reading the way the row does.
// A caller whose footer has a THIRD slot (a delete on the left) has to send it to the far end explicitly -
// otherwise being first in the markup lands it at the bottom edge. See WriteDialog's `footerStart`.
// Inside a
// `scrollBody` dialog it sits outside the scroll area and so stays visible; in a plain dialog the whole panel
// scrolls (a grid item's stickiness is bounded by its own one-row grid area, so `sticky` would travel nowhere).
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
