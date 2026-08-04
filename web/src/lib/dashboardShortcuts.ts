// The dashboard's shortcut tiles (the row at the bottom of the dashboard). Unlike the top-bar "+" menu - which
// is only ever create/request FLOWS - a shortcut can also be a plain destination, so an org can point people at
// the two or three places they actually live in. The org picks the tiles and their order in
// Settings → Dashboard → Shortcuts, stored as `shortcuts` in the settings/dashboard blob; an empty list hides
// the row entirely. Per-user gating still applies at render, so nobody sees a tile they can't use.
//
// Ids are namespaced by kind:
//   action:<quick action id>  - runs the create/request flow (lib/quickActions)
//   page:<route key>          - navigates to a nav page or workspace tab (nav.ts)
import type { LucideIcon } from "lucide-react";
import { NAV, itemVisible, navPerm } from "@/nav";
import { hasCapability } from "@/lib/perm";
import { QUICK_ACTIONS, runQuickAction } from "@/lib/quickActions";
import { navigate } from "@/router";
import type { Me } from "@/types";

export type ShortcutDef = {
  id: string;
  label: string;
  detail: string; // where it lives: the action's group, or the nav group for a page
  icon: LucideIcon;
  kind: "action" | "page";
  visible: (me: Me) => boolean;
  run: () => void;
};

// Everything the org can put on the dashboard: every quick action (including the standalone top-bar ones - they
// are actions the caller can perform, and the "+" menu config doesn't govern this row), then every nav
// destination. Workspace items contribute their TABS rather than the item itself, so "Pay: Payslips" and
// "Pay: Loans" are separate targets.
export function shortcutCatalog(): ShortcutDef[] {
  const actions: ShortcutDef[] = QUICK_ACTIONS.map((a) => ({
    id: `action:${a.id}`,
    label: a.label,
    detail: a.group,
    icon: a.icon,
    kind: "action",
    visible: a.visible,
    run: () => runQuickAction(a),
  }));
  const pages: ShortcutDef[] = NAV.flatMap((g) =>
    g.items.flatMap((i): ShortcutDef[] => {
      const page = (key: string, label: string, gate: (me: Me) => boolean): ShortcutDef => ({
        id: `page:${key}`,
        label,
        detail: g.label,
        icon: i.icon,
        kind: "page",
        visible: gate,
        run: () => navigate(key),
      });
      if (i.tabs) {
        return i.tabs.map((t) => {
          const p = navPerm(t);
          return page(t.key, `${i.label}: ${t.label}`, (me) => !p || hasCapability(me.capabilities, p));
        });
      }
      return [page(i.key, i.label, (me) => itemVisible(i, (p) => hasCapability(me.capabilities, p)))];
    }),
  );
  return [...actions, ...pages];
}

// Shown when the org hasn't configured the row: the everyday self-service asks plus the two destinations most
// people come back to. Capability gating trims it per person.
export const DEFAULT_DASHBOARD_SHORTCUTS = [
  "action:request-leave",
  "action:new-reimbursement",
  "action:new-ticket",
  "page:employees",
  "page:payslips",
];

// The tiles to render for this caller: the configured ids in order (unknown ids dropped, unusable ones gated
// out). An explicitly EMPTY configured list means the org turned the row off - nothing renders.
export function resolveDashboardShortcuts(me: Me, ids?: string[]): ShortcutDef[] {
  const byId = new Map(shortcutCatalog().map((s) => [s.id, s]));
  return (ids ?? DEFAULT_DASHBOARD_SHORTCUTS)
    .map((id) => byId.get(id))
    .filter((s): s is ShortcutDef => !!s && s.visible(me));
}
