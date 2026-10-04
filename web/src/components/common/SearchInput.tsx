import * as React from "react";
import { Input } from "@/components/ui/input";
import { useMedia } from "@/hooks/useMedia";
import { useSlashTarget, withSlashHint } from "@/lib/slashSearch";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "placeholder"> & {
  placeholder: string;
  /** `/` reaches this box only when no other search box is showing (lib/slashSearch.ts). */
  slashFallback?: boolean;
};

// Every search box in the app: `/` reaches it (lib/slashSearch.ts) and its placeholder says so while it is the
// box `/` would land in. The hint is shown only with a fine pointer - a phone has no `/` key to press. The
// accessible name is the placeholder WITHOUT the hint, so it reads the same whether or not the hint is up.
export const SearchInput = React.forwardRef<HTMLInputElement, Props>(({ placeholder, "aria-label": label, slashFallback, ...props }, ref) => {
  const [el, setEl] = React.useState<HTMLInputElement | null>(null);
  const reachable = useSlashTarget(el, slashFallback);
  const keyboard = useMedia("(hover: hover) and (pointer: fine)");
  const setRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      setEl(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  return (
    <Input
      {...props}
      ref={setRef}
      type="search"
      placeholder={reachable && keyboard ? withSlashHint(placeholder) : placeholder}
      aria-label={label ?? placeholder}
      aria-keyshortcuts={reachable ? "/" : undefined}
    />
  );
});
SearchInput.displayName = "SearchInput";
