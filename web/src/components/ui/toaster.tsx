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

const ICONS = {
  success: <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />,
  destructive: <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />,
  default: <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" />,
};

export function Toaster() {
  const { toasts } = useToast();
  return (
    <ToastProvider swipeDirection="right">
      {toasts.map(({ id, title, description, variant, action, duration: _duration, ...props }) => (
        <Toast key={id} variant={variant} {...props}>
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
                className="mt-1 w-fit rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
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
