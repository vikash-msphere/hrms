import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const resolver = React.useRef<((v: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((o) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!opts} onOpenChange={(o) => !o && close(false)}>
        <DialogContent
          className="max-w-md"
          // Enter confirms from anywhere in the dialog (Esc cancels via the dialog default), so a confirmation
          // is a single keystroke. preventDefault stops a focused button's own Enter-activation double-firing.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              close(true);
            }
          }}
        >
          <DialogHeader>
            <div className="flex items-start gap-3">
              {opts?.destructive && (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                </div>
              )}
              <div className="space-y-1">
                <DialogTitle>{opts?.title}</DialogTitle>
                {opts?.description && <DialogDescription>{opts.description}</DialogDescription>}
              </div>
            </div>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {opts?.cancelLabel ?? "Cancel"}
            </Button>
            <Button variant={opts?.destructive ? "destructive" : "default"} autoFocus={!opts?.destructive} onClick={() => close(true)}>
              {opts?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
