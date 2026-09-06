import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// The id a surrounding <Field> minted for this select, handed down to the TRIGGER.
//
// Radix's root takes no id (it renders nothing), and the trigger is written by the call site - so a Field
// had no way to point its `<label for>` at anything, and every select in the app was a control whose name a
// screen reader could not read: it announced the current VALUE and nothing about what the value is for.
// Field now clones this root with an `id`, which arrives here and lands on the trigger.
const SelectIdCtx = React.createContext<string | undefined>(undefined);

function Select({ id, ...props }: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root> & { id?: string }) {
  return (
    <SelectIdCtx.Provider value={id}>
      <SelectPrimitive.Root {...props} />
    </SelectIdCtx.Provider>
  );
}
// Set explicitly: <Field> identifies the controls it may bind its label to by displayName, and a minified
// production build mangles Function.name.
Select.displayName = "Select";

const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => {
  const fieldId = React.useContext(SelectIdCtx);
  return (
  <SelectPrimitive.Trigger
    ref={ref}
    id={props.id ?? fieldId}
    className={cn(
      // coarse:min-h-10 mirrors the phone floor index.css puts on native inputs, so a form's selects and its
      // text fields end up the same height on touch. `min-h` rather than `h` so a caller who deliberately
      // sized a dense trigger keeps its layout and only gains the target.
      // `min-w-0` for the same reason as ui/input.tsx: the trigger's label is a flex child of this box
      // and the box is usually a flex child of a filter row, so without a zeroed floor the row's width
      // is the sum of every option label it might show. `truncate` on the label so the shrink degrades
      // into an ellipsis rather than the text sliding out under the chevron.
      "flex h-9 w-full min-w-0 items-center justify-between gap-1 rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 coarse:min-h-10 [&>span]:line-clamp-1 [&>span]:truncate [&>span]:text-left",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      {/* shrink-0: the chevron is the affordance that says "this is a select". When the trigger is
          squeezed it is the label that gives, never the marker. */}
      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
  );
});
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        // The height ceiling is whatever Radix measured as available to the trigger, capped at 18rem - so a
        // long list on a short phone screen scrolls inside the popup instead of being clipped by the viewport,
        // and a trigger near the bottom of the screen still opens upward with its full list reachable.
        "relative z-50 max-h-[min(18rem,var(--radix-select-content-available-height))] min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
        className
      )}
      position={position}
      {...props}
    >
      <SelectPrimitive.Viewport
        // max-w keeps a long option label from pushing the popup off a narrow screen; it wraps or ellipsises
        // inside instead (see SelectItem).
        className={cn(
          "max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-1",
          position === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} className={cn("px-2 py-1.5 text-xs font-semibold text-muted-foreground", className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export { Select, SelectGroup, SelectLabel, SelectValue, SelectTrigger, SelectContent, SelectItem };
