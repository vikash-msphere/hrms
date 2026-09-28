import * as React from "react";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AppLockSettings } from "@/components/lock/AppLockSettings";

// The app lock settings as a sheet, reachable from the top bar's lock button (first use), the avatar menu
// (first use) and the command palette - for everyone, including an account with no employee record and so no profile page.

let open = false;
let setup = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Open the app lock settings. `setup` goes straight to choosing a PIN when none is set. */
export function openAppLockSettings(opts: { setup?: boolean } = {}) {
  open = true;
  setup = !!opts.setup;
  emit();
}

export function AppLockSheet() {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    subs.add(force);
    return () => {
      subs.delete(force);
    };
  }, []);
  const close = () => {
    open = false;
    emit();
  };
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : close())}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>App lock</SheetTitle>
          <SheetDescription>Protect this app with a PIN on your devices.</SheetDescription>
        </SheetHeader>
        <SheetBody>{open && <AppLockSettings startSetup={setup} onDone={close} heading={false} />}</SheetBody>
      </SheetContent>
    </Sheet>
  );
}
