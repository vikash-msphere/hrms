import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, inputMode, enterKeyHint, onWheel, ...props }, ref) => {
    const numeric = type === "number";
    const search = type === "search";
    return (
      <input
        type={type}
        ref={ref}
        // A phone treats a text field as prose by default: it capitalises the first letter, autocorrects what
        // it does not recognise, and underlines the rest in red. A search box is none of those things - a
        // surname, a serial, an asset tag. Callers can still override any of the three.
        {...(search ? { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } : {})}
        // Which keyboard a phone opens is decided here rather than at ~90 call sites. `type="number"` alone
        // is not the answer on touch: browsers disagree about whether it offers a decimal point at all, and
        // several open the full keyboard with a number row rather than a keypad. The hint is advisory and a
        // field that wants the integer pad (a count, a day of the month) passes `inputMode="numeric"` itself.
        inputMode={inputMode ?? (numeric ? "decimal" : undefined)}
        // What the Enter key says. Left to the caller everywhere except the one case with a single sensible
        // answer: a search field's Enter searches.
        enterKeyHint={enterKeyHint ?? (type === "search" ? "search" : undefined)}
        // A focused `type="number"` treats the scroll wheel as increment/decrement, so scrolling a form with
        // the pointer over a salary field silently edits it - and the edit looks like the user's own. Dropping
        // focus is the only reliable stop: React attaches `wheel` passively at the root, so the event cannot be
        // cancelled from here.
        onWheel={(e) => {
          if (numeric && e.currentTarget === document.activeElement) e.currentTarget.blur();
          onWheel?.(e);
        }}
        className={cn(
          // `min-w-0` is load-bearing on a narrow screen. An <input> has an intrinsic min-content width
          // of roughly its `size` attribute - about 170px by default - and a flex item's automatic
          // minimum size is that min-content width. So a field with `flex-1` in a row alongside a
          // select and two icon buttons will NOT shrink below ~170px; it pushes the row past the
          // viewport instead, and the row's own siblings go with it. Zeroing the floor here fixes every
          // such row in the app at once rather than at ~90 call sites, and costs nothing where there is
          // room (the `w-full`/`flex-1` basis still claims all of it).
          "flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          // Safari renders a search field with its own rounded chrome and an inner clear button of its own
          // metrics; the appearance reset keeps `type="search"` a semantic choice rather than a visual one.
          type === "search" && "[&::-webkit-search-cancel-button]:appearance-none",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
