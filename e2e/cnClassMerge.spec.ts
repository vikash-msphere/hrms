import { cn } from "../web/src/lib/utils";
import { test, expect } from "./fixtures";

// `cn` (lib/utils.ts) is `twMerge(clsx(inputs))`, called at nearly every className in the app instead of a
// plain template string, for exactly one reason: a later conflicting Tailwind utility has to WIN, not just
// sit next to the earlier one waiting on the compiled stylesheet's own rule order to decide. Confirming that
// from inside a rendered page conflates two things - cn's own merge and whatever order Tailwind happened to
// emit the two classes' rules in the CSS it built - so the only place this claim is actually provable is the
// return value itself, which is exactly what this drives straight at.
//
// No browser needed - `cn` is a pure function with no DOM dependency - so this runs the real shipped function
// (the same module every component imports) directly in the test process, the same way the specs elsewhere
// in this file drive it through a page.
test.describe("cn (Tailwind class merge)", () => {
  test("a later conflicting utility replaces the earlier one, not both", () => {
    // Same property (background colour): naive concatenation would leave both classes in the string, and
    // which one wins would be down to the compiled stylesheet's own rule order, not the call site's.
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
    // Same property (padding), values on both axes - a scale change, not just a colour, has to merge too.
    expect(cn("p-2", "p-4")).toBe("p-4");
    // A CONDITIONAL override, the actual shape every component calls this with (`cn(base, active && override)`):
    // the base's conflicting class must not survive alongside the one the condition turned on.
    expect(cn("text-muted-foreground", true && "text-foreground")).toBe("text-foreground");
  });

  test("non-conflicting classes all survive, and falsy/nullish inputs are dropped", () => {
    // clsx's half of the job: false/null/undefined/"" contribute nothing, and nothing about them survives
    // into the class list a naive `${a} ${b}` template would have left literal "false"/"null" text in.
    const merged = cn("flex", "items-center", false && "hidden", null, undefined, "" as const, "gap-2");
    expect(merged.split(" ").sort()).toEqual(["flex", "gap-2", "items-center"]);
  });

  test("an object form toggles classes by their own truthiness", () => {
    expect(cn({ block: true, hidden: false, "text-sm": true })).toBe("block text-sm");
  });
});
