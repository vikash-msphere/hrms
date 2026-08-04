import { useEffect, useRef, useState } from "react";
import { navigate } from "@/router";
import { navItem, workspaceForKey, itemVisible, navPerm } from "@/nav";
import { hasCapability } from "@/lib/perm";
import type { Me } from "@/useMe";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

// g-chord destinations: `g` then a letter jumps to a page. Gated by the same nav visibility rules as the
// sidebar, so a chord can never take someone to a page the nav would hide from them.
const GO: [string, string, string][] = [
  // [key, route, label]
  ["d", "dashboard", "Dashboard"],
  ["a", "approvals", "Approvals"],
  ["l", "leave-requests", "Leave"],
  ["c", "leave-calendar", "Leave calendar"],
  ["e", "employees", "Team directory"],
  ["b", "boards", "Boards"],
  ["f", "announcements", "Feed"],
  ["t", "tickets", "Support"],
  ["p", "payslips", "Pay"],
  ["x", "expenses", "Expenses"],
  ["m", "attendance", "Attendance (time)"],
  ["n", "notifications", "Notifications"],
  ["o", "documents", "Documents"],
  ["s", "settings", "Settings"],
];

// True while the event's target is somewhere typing is expected - shortcuts must never eat those keys.
function isTypingTarget(el: EventTarget | null): boolean {
  const n = el instanceof HTMLElement ? el : null;
  if (!n) return false;
  return n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" || n.isContentEditable;
}

// Whether a chord destination is visible to this user, by the sidebar's own rules. Routes without a nav
// item (notifications, tickets live under other affordances) are allowed - their pages self-gate.
function canGo(route: string, me: Me): boolean {
  const item = navItem(route);
  if (!item) return true;
  return itemVisible(item, (p) => hasCapability(me.capabilities, p));
}

/** Global keyboard layer: `?` opens the shortcut reference, `g`+letter jumps between pages, `[`/`]` walk the
 *  current workspace's tabs. Typing surfaces and open dialogs are left alone; ⌘K stays in CommandPalette. */
export function ShortcutLayer({ me, page }: { me: Me; page: string }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const armed = useRef(0); // timestamp when `g` was pressed; a chord completes within 1.5s

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // An open dialog/sheet owns the keyboard (its own Enter/Esc semantics).
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;

      const now = Date.now();
      if (armed.current && now - armed.current < 1500) {
        armed.current = 0;
        const dest = GO.find(([k]) => k === e.key.toLowerCase());
        if (dest && canGo(dest[1], me)) {
          e.preventDefault();
          navigate(dest[1]);
        }
        return;
      }
      if (e.key === "g") {
        armed.current = now;
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (e.key === "[" || e.key === "]") {
        const ws = workspaceForKey(page);
        if (!ws?.tabs) return;
        const tabs = ws.tabs.filter((t) => { const p = navPerm(t); return !p || hasCapability(me.capabilities, p); });
        const i = tabs.findIndex((t) => t.key === page);
        if (i < 0 || tabs.length < 2) return;
        e.preventDefault();
        navigate(tabs[(i + (e.key === "]" ? 1 : tabs.length - 1)) % tabs.length]!.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [me, page]);

  const chords = GO.filter(([, route]) => canGo(route, me));
  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? anywhere to open this reference.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Everywhere</p>
            <ShortcutRow keys={["⌘", "K"]} label="Search everything" />
            <ShortcutRow keys={["["]} label="Previous workspace tab" />
            <ShortcutRow keys={["]"]} label="Next workspace tab" />
            <ShortcutRow keys={["↑", "↓"]} label="Move between table rows" />
            <ShortcutRow keys={["Enter"]} label="Open the focused row" />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Go to (press g, then…)</p>
            <div className="max-h-64 overflow-y-auto pr-1">
              {chords.map(([k, , label]) => (
                <ShortcutRow key={k} keys={["g", k]} label={label} />
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex shrink-0 gap-1">
        {keys.map((k, i) => (
          <kbd key={i} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}
