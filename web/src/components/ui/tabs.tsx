import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { useScrollActiveIntoView } from "@/hooks/useScrollActiveIntoView";

const Tabs = TabsPrimitive.Root;

// Two looks: "segmented" (the default pill bar, for secondary in-page sub-tabs) and "underline" (matches the
// workspace tab bar in layout/Workspace.tsx, for a page's top-level tabs so they read identically to the
// sidebar workspaces). The variant set on TabsList flows to its triggers via context.
type TabsVariant = "segmented" | "underline";
const TabsVariantContext = React.createContext<TabsVariant>("segmented");

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = "segmented", ...props }, ref) => {
  // Scroll the selected tab into view when the strip is wider than the box (a phone, or a settings panel
  // inside a narrow Sheet). Own ref, merged with the caller's - see hooks/useScrollActiveIntoView.ts.
  const inner = React.useRef<HTMLDivElement | null>(null);
  useScrollActiveIntoView(inner as React.RefObject<HTMLElement>);
  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [ref],
  );
  return (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={setRefs}
      className={cn(
        variant === "underline"
          ? "scroll-shadow-x no-scrollbar mb-6 flex items-center gap-1 overflow-x-auto border-b text-muted-foreground"
          // max-w-full + scroll: a settings panel's tab bar has to survive a narrow inline Sheet and a phone.
          // The segmented bar's own ground is `muted`, so the scroll-fade has to be told what to blend into
          // (the utility defaults to the page background).
          : "scroll-shadow-x no-scrollbar inline-flex h-9 max-w-full items-center justify-start overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground [--scroll-ground:hsl(var(--muted))] coarse:h-11",
        className
      )}
      {...props}
    />
  </TabsVariantContext.Provider>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        variant === "underline"
          // coarse:min-h-11 - a finger-sized target; the underline bar has no fixed track height to fight.
          // shrink-0 for the same reason as the segmented pill: in the scrolling strip a shrinkable item is
          // squeezed narrower than its nowrap label, which then spills over the tab beside it.
          ? "-mb-px shrink-0 border-b-2 border-transparent px-3 py-2.5 text-muted-foreground hover:border-border hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground coarse:min-h-11"
          // The segmented pill fills its track instead (the track itself grows on touch, see TabsList).
          : "h-full shrink-0 rounded-md px-3 py-1 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        className
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-4 ring-offset-background focus-visible:outline-hidden", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
