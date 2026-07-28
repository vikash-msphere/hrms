import * as React from "react";
import { ExternalLink } from "lucide-react";
import type { Me } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { AccessTarget } from "@/components/access/AccessTarget";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";
import { settingsEntry, hostSettings, entryScope } from "@/settings/registry";
import { hasCapability, useCapabilities, usePermission } from "@/lib/perm";
import { useRoute, setQueryParam, setQueryParams, navigate } from "@/router";
import { useToast } from "@/components/ui/use-toast";

// The heavy panel bodies live in their own on-demand chunk; this lazy import is what keeps a feature page's
// bundle lean - nothing here pulls Settings.tsx until the sheet actually opens.
const SettingsPanelContent = React.lazy(() =>
  import("@/settings/panels").then((m) => ({ default: m.SettingsPanelContent })),
);

const panelLoading = <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>;

// A gear on a feature page that opens that page's relevant settings panel inline, in a right-docked Sheet -
// the SAME panel as the central Settings hub, no navigation away. One affordance for every scope:
//   org    - a singleton (leave policy, pay components). Gated on settings.write + entry.perm.
//   object - one instance's config (a board's columns/swimlanes). `objectPath` is required and is threaded to
//            the panel + the ACL header + the deep-link; gated on the object's own verb (via `can`).
//   user   - the caller's own preferences (notification mutes). Ungated; always visible.
// Open state is deep-linked via `?setting=<key>` (+ `?settingObj=<objectPath>` for object scope) on the page
// hash, so it is shareable and the back button closes it. Renders nothing when the caller may not open it.
export function SettingsButton({
  me,
  settingKey,
  objectPath,
  can,
  openId,
}: {
  me: Me;
  settingKey: string;
  objectPath?: string; // object scope: which instance this gear configures
  can?: string[]; // object scope: the instance's access.can, for gating the gear
  openId?: string;
}) {
  const entry = settingsEntry(settingKey);
  const writable = usePermission("settings.write");
  const caps = useCapabilities();
  const route = useRoute();
  const { toast } = useToast();
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);

  if (!entry) return null;
  const scope = entryScope(entry);

  // Visibility gate, per scope.
  const gateOk =
    scope === "user" ? true
    : scope === "object" ? !!can?.includes(entry.target?.verb ?? "configure")
    : writable && (!entry.perm || hasCapability(caps, entry.perm)); // org
  if (!gateOk) return null;
  if (scope === "object" && !objectPath) return null;

  // Object scope keys the open state on both the setting AND which instance, so the gear is "open" only for the
  // instance whose path is in the hash (switching the selected board closes a stale sheet).
  const open =
    route.query.setting === settingKey &&
    (scope !== "object" || route.query.settingObj === objectPath);
  const itemId = open ? route.query.settingItem || openId : openId;
  const Icon = entry.icon;

  const openSheet = () =>
    scope === "object"
      ? setQueryParams({ setting: settingKey, settingObj: objectPath! })
      : setQueryParam("setting", settingKey);
  const closeSheet = () => setQueryParams({ setting: null, settingObj: null });

  // Object scope resolves the ACL target at runtime (the registry can't know the instance path).
  const target: AccessTargetRef | undefined =
    scope === "object" && entry.target
      ? { ...entry.target, objectPath, can }
      : entry.target;

  return (
    <Sheet open={open} onOpenChange={(o) => (o ? openSheet() : closeSheet())}>
      <Button variant="outline" size="icon" title={entry.title} aria-label={entry.title} onClick={openSheet}>
        <Icon className="h-4 w-4" />
      </Button>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-center gap-1.5">
            <SheetTitle>{entry.title}</SheetTitle>
            {target && <AccessTarget target={target} className="h-6 w-6" />}
          </div>
          <SheetDescription>{entry.desc}</SheetDescription>
          {/* Header portal for the few Access panels that park a control strip inline. */}
          <div ref={setSlot} className="mt-2 flex flex-wrap items-center gap-2 empty:mt-0" />
        </SheetHeader>
        <SheetBody>
          {open && (
            <React.Suspense fallback={panelLoading}>
              <SettingsPanelContent entryKey={entry.key} me={me} toast={toast} slot={slot} openId={itemId} objectPath={objectPath} onClose={closeSheet} />
            </React.Suspense>
          )}
        </SheetBody>
        {/* Org singletons deep-link to their full settings page; non-org config already lives on this page. */}
        {scope === "org" && (
          <SheetFooter>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => navigate(`settings/${entry.key}`)}
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open full settings
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

// Drop-in for a page header's `actions` slot: renders the gear(s) mapped to this host page (registry
// HOST_SETTINGS). One mechanism for every wired page - add a map row, not JSX. (HOST_SETTINGS is org-scoped
// only; object/user gears are placed directly on their page, since they need an instance path.)
export function PageSettings({ me, host }: { me: Me; host: string }) {
  const keys = hostSettings(host);
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((k) => (
        <SettingsButton key={k} me={me} settingKey={k} />
      ))}
    </>
  );
}
