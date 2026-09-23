import * as React from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const ToastProvider = ToastPrimitives.Provider;

/**
 * Keep the toast stack in the accessibility tree while a dialog is open.
 *
 * A Radix modal hides the rest of the page from assistive tech by walking `document.body`'s children and
 * stamping `aria-hidden="true"` (plus its own `data-aria-hidden` bookkeeping marker) on every one that is not
 * the dialog. The toast viewport is one of those children - so from the moment any dialog opened, every
 * confirmation and every ERROR the app raised was announced to nobody, which is exactly when the app has the
 * most to say: almost every write in this app is made from inside a dialog.
 *
 * Radix offers no way to exempt a node, so this un-hides ours as the sweep happens. Only `aria-hidden` is
 * removed; `data-aria-hidden` is left alone, because that is the attribute the library queries to find what it
 * hid - stripping it would strand the node when the dialog closes. It is a live region reporting the result of
 * what the reader just did, and it is never behind the modal's scrim, so nothing about it is "the rest of the
 * page" that the modal is entitled to silence.
 */
/** Give the node to the caller's ref AND to our own, so the forwarded ref keeps working. */
function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

function useAlwaysAnnounced(ref: React.RefObject<HTMLElement>) {
  React.useEffect(() => {
    // The forwarded ref lands on the `<ol>`; the node Radix hides is the `role="region"` wrapper it puts
    // around it, which is the actual child of `document.body` the modal's sweep walks over.
    const region = ref.current?.closest('[role="region"]');
    if (!region) return;
    const unhide = () => region.hasAttribute("aria-hidden") && region.removeAttribute("aria-hidden");
    unhide(); // a dialog open before this mounted has already stamped it
    const observer = new MutationObserver(unhide);
    observer.observe(region, { attributes: true, attributeFilter: ["aria-hidden"] });
    return () => observer.disconnect();
  }, [ref]);
}

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => {
  const own = React.useRef<HTMLOListElement>(null);
  useAlwaysAnnounced(own);
  return (
  <ToastPrimitives.Viewport
    ref={mergeRefs(ref, own)}
    className={cn(
      // On a phone the toast stack has to clear the home indicator, otherwise every confirmation lands under
      // the gesture bar. From `md` up there is no inset, so it returns to the corner.
      // The side insets are the landscape notch: a full-width stack would otherwise start under it.
      "fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[100] flex max-h-screen w-full flex-col gap-2 p-4 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] md:inset-x-auto md:bottom-0 md:right-0 md:max-w-[400px]",
      className
    )}
    {...props}
  />
  );
});
ToastViewport.displayName = ToastPrimitives.Viewport.displayName;

const toastVariants = cva(
  // The data-[swipe] set makes the card follow the finger and leave along the axis it was pushed. Radix only
  // publishes the offset for the axis in use, so both translations read their own var with a 0 fallback -
  // which lets the swipe direction differ by breakpoint (down on a phone, right on a desktop; see toaster.tsx)
  // without the classes having to change with it.
  "group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border bg-card p-4 pr-8 shadow-lg transition-all data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=open]:slide-in-from-bottom-full data-[state=closed]:slide-out-to-right-full data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x,0px)] data-[swipe=move]:translate-y-[var(--radix-toast-swipe-move-y,0px)] data-[swipe=move]:transition-none data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:translate-y-0 data-[swipe=end]:animate-out",
  {
    variants: {
      variant: {
        // Keep an opaque background (the base bg-card) so a toast shown over a modal's grey/blur scrim isn't
        // tinted through it; the colored border + icon convey the variant.
        default: "border-border",
        destructive: "border-destructive/40",
        success: "border-success/40",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> & VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => (
  <ToastPrimitives.Root ref={ref} className={cn(toastVariants({ variant }), className)} {...props} />
));
Toast.displayName = ToastPrimitives.Root.displayName;

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      // A toast is transient, so its dismiss has to be hit first time - the glyph stays 16px, the box grows.
      "absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground opacity-60 transition-opacity hover:opacity-100 coarse:h-11 coarse:w-11",
      className,
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
));
ToastClose.displayName = ToastPrimitives.Close.displayName;

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title ref={ref} className={cn("text-sm font-semibold", className)} {...props} />
));
ToastTitle.displayName = ToastPrimitives.Title.displayName;

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
ToastDescription.displayName = ToastPrimitives.Description.displayName;

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>;
type ToastActionElement = React.ReactElement;

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
};
