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

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const resolver = React.useRef<((v: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((o) => {
    // The outgoing resolver is SETTLED before it is replaced. There is one slot, so a second `confirm()` while
    // one was open overwrote it and the first promise never settled - and every decision handler in the app is
    // `if (!(await confirmDecision(...))) return; setBusy(true); try { … } finally { setBusy(false) }`, so the
    // caller's `finally` never ran: a button that spins forever and a row that cannot be acted on again without
    // a reload. Reachable by double-pressing a destructive row action before the dialog paints (the trigger is
    // not disabled during the await), and by any two overlapping prompts.
    //
    // Resolved FALSE, not rejected: "the prompt this call was waiting on was replaced" means the person never
    // agreed to anything, which is exactly what false says - and a rejection would turn it into an error toast
    // in handlers that do not expect confirm to throw.
    resolver.current?.(false);
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
          // Above every other dialog: a confirmation is nearly always asked BY an open dialog (discard these
          // changes, delete this row), and portals paint in mount order, which would put this one behind.
          className="z-[60] max-w-md"
          overlayClassName="z-[60]"
          // Enter confirms from anywhere in the dialog (Esc cancels via the dialog default), so an ordinary
          // confirmation is a single keystroke - EXCEPT on a button, which activates itself.
          //
          // A DESTRUCTIVE PROMPT IS EXEMPT ENTIRELY. `autoFocus` is withheld there so nobody deletes by
          // reflex, which leaves focus on the dialog itself - and "Enter confirms from anywhere" then handed
          // the reflex back: focus is not on a button, so the guard below does not fire and a bare Enter ran
          // `close(true)`. Pressing a row's Delete and then pressing Enter (a double-press, a held key, a
          // keyboard user finishing the form behind it) confirmed the delete without reading the prompt.
          // Every `confirm({ destructive: true })` in the app - reject, cancel, revoke, rescind, "Discard your
          // changes?", the bulk destructive actions, the purge prompts.
          //
          // A destructive prompt is therefore answered by pressing a button: Tab to it, or click it. That is
          // the same standard ui/dialog.tsx holds `onEnterSubmit` to, which takes Enter only from an <input>
          // or with a modifier - enough to finish a form, not enough to be a reflex.
          onKeyDown={(e) => {
            if (e.key !== "Enter" || opts?.destructive) return;
            if ((e.target as HTMLElement | null)?.closest("button")) return; // let the focused button act
            e.preventDefault();
            close(true);
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
