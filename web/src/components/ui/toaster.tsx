import { CheckCircle2, AlertCircle, Info } from "lucide-react";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast";
import { useToast } from "./use-toast";
import { useMedia } from "@/hooks/useMedia";

const ICONS = {
  success: <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />,
  destructive: <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />,
  default: <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" />,
};

export function Toaster() {
  const { toasts } = useToast();
  // Swipe a toast away along the axis it can leave by: down on a phone, where the stack spans the width and
  // there is no side to flick it off, right on a wider screen, where it sits in the corner.
  const phone = useMedia("(max-width: 767px)");
  return (
    <ToastProvider swipeDirection={phone ? "down" : "right"}>
      {/* `duration` is handed to Radix rather than stripped: the primitive runs the only close timer (the store
          fills in its default, see use-toast.ts), and it falls back to the provider's 5s when given nothing. */}
      {toasts.map(({ id, title, description, variant, action, duration, ...props }) => (
        <Toast key={id} variant={variant} duration={duration} {...props}>
          {ICONS[(variant as keyof typeof ICONS) ?? "default"] ?? ICONS.default}
          <div className="grid gap-0.5">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
            {action && (
              <button
                type="button"
                onClick={() => {
                  action.onClick();
                  props.onOpenChange?.(false);
                }}
                // Undo lives here (see lib/*, the undo toasts): it is the most time-pressured button in the
                // app, so it gets a real target rather than a 26px chip.
                className="mt-1.5 w-fit rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent coarse:min-h-9 coarse:px-4 coarse:text-sm"
              >
                {action.label}
              </button>
            )}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
