import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

/**
 * A confirmation that cannot be agreed to without saying why - a rejection, which the requester is told the
 * reason for. The confirm button stays disabled until the box holds something other than whitespace.
 */
export type ReasonOptions = ConfirmOptions & {
  reasonLabel: string;
  placeholder?: string;
  maxLength?: number;
  /** What is being decided, under the description. Masked from session replay: it is usually a colleague's
   *  request (an amount, a date range), and a dialog is a portal outside any route mask. */
  detail?: React.ReactNode;
};

/** Resolves to the trimmed reason, or null when the person backs out. */
export type AskReasonFn = (opts: ReasonOptions) => Promise<string | null>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);
const AskReasonContext = React.createContext<AskReasonFn | null>(null);

type Prompt = ConfirmOptions & Partial<ReasonOptions> & { withReason: boolean };

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = React.useState<Prompt | null>(null);
  const [reason, setReason] = React.useState("");
  // One slot for both kinds of prompt. A plain confirmation resolves "" for yes; null is always "backed out".
  const resolver = React.useRef<((v: string | null) => void) | null>(null);

  const open = React.useCallback((o: Prompt) => {
    // The outgoing resolver is SETTLED before it is replaced. There is one slot, so a second `confirm()` while
    // one was open overwrote it and the first promise never settled - and every decision handler in the app is
    // `if (!(await confirmDecision(...))) return; setBusy(true); try { … } finally { setBusy(false) }`, so the
    // caller's `finally` never ran: a button that spins forever and a row that cannot be acted on again without
    // a reload. Reachable by double-pressing a destructive row action before the dialog paints (the trigger is
    // not disabled during the await), and by any two overlapping prompts.
    //
    // Resolved as BACKED OUT, not rejected: "the prompt this call was waiting on was replaced" means the person
    // never agreed to anything, which is exactly what false/null says - and a rejection would turn it into an
    // error toast in handlers that do not expect confirm to throw.
    resolver.current?.(null);
    setReason("");
    setOpts(o);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const confirm = React.useCallback<ConfirmFn>((o) => open({ ...o, withReason: false }).then((v) => v !== null), [open]);
  const askReason = React.useCallback<AskReasonFn>((o) => open({ ...o, withReason: true }), [open]);

  const close = (result: string | null) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  };
  const trimmed = reason.trim();
  const accept = () => {
    if (!opts?.withReason) return close("");
    if (trimmed) close(trimmed);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      <AskReasonContext.Provider value={askReason}>
        {children}
        <Dialog open={!!opts} onOpenChange={(o) => !o && close(null)}>
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
            // or with a modifier - enough to finish a form, not enough to be a reflex. A reason prompt takes
            // Enter in its box as a new line, and is answered by its button the same way.
            onKeyDown={(e) => {
              if (e.key !== "Enter" || opts?.destructive || opts?.withReason) return;
              if ((e.target as HTMLElement | null)?.closest("button")) return; // let the focused button act
              e.preventDefault();
              accept();
            }}
          >
            <DialogHeader>
              <div className="flex items-start gap-3">
                {opts?.destructive && (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                )}
                <div className="min-w-0 space-y-1">
                  <DialogTitle>{opts?.title}</DialogTitle>
                  {opts?.description && <DialogDescription>{opts.description}</DialogDescription>}
                  {opts?.detail && <p className="text-sm text-muted-foreground" data-sentry-mask>{opts.detail}</p>}
                </div>
              </div>
            </DialogHeader>
            {opts?.withReason && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm-reason">{opts.reasonLabel}</Label>
                {/* Focused on open: the box is the next thing to do, and typing in it is not a reflex the way
                    pressing a destructive button is - the button stays disabled until there is a reason. */}
                <Textarea
                  id="confirm-reason"
                  autoFocus
                  required
                  value={reason}
                  maxLength={opts.maxLength ?? 1000}
                  placeholder={opts.placeholder}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => close(null)}>
                {opts?.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={opts?.destructive ? "destructive" : "default"}
                autoFocus={!opts?.destructive && !opts?.withReason}
                disabled={!!opts?.withReason && !trimmed}
                onClick={accept}
              >
                {opts?.confirmLabel ?? "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </AskReasonContext.Provider>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}

export function useAskReason(): AskReasonFn {
  const ctx = React.useContext(AskReasonContext);
  if (!ctx) throw new Error("useAskReason must be used within ConfirmProvider");
  return ctx;
}
