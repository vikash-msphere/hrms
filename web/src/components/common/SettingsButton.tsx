import * as React from "react";
import { ExternalLink, Settings2 } from "lucide-react";
import type { Me } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetBody, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AccessTarget } from "@/components/access/AccessTarget";
import { PanelSkeleton } from "@/components/common/Skeletons";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";
import { settingsEntry, hostSettings, entryScope, settingsEntryVisible, type SettingsEntry, type SettingsScope } from "@/settings/registry";
import { useCapabilities } from "@/lib/perm";
import { useRoute, setQueryParam, setQueryParams, navigate } from "@/router";
import { useToast } from "@/components/ui/use-toast";
import { lazyPage } from "@/lib/lazyPage";

// The heavy panel bodies live in their own on-demand chunk; this lazy import is what keeps a feature page's
// bundle lean - nothing here pulls Settings.tsx until the sheet actually opens.
// lazyPage, not React.lazy: a failed import must stay retryable (see lib/lazyPage.tsx and the crash boundary).
const SettingsPanelContent = lazyPage(() =>
  import("@/pages/Settings").then((m) => ({ default: m.SettingsPanelContent })),
);

const panelLoading = <PanelSkeleton />;

// One setting a surface offers. `objectPath` + `can` are for object scope: which instance it configures, and
// that instance's access.can for the gate.
export type SettingsItem = { key: string; objectPath?: string; can?: string[] };

type Resolved = { entry: SettingsEntry; scope: SettingsScope; objectPath?: string; can?: string[] };

// Who may open a setting, per scope:
//   org    - a singleton (leave policy, pay components): write on what the panel edits (registry.ts
//            settingsEntryVisible - the same rule the Settings hub uses).
//   object - one instance's config (a board's columns/swimlanes). The instance's own verb, and a path.
//   user   - the caller's own preferences (notification mutes). Everyone.
function canOpenSetting(r: Resolved, caps: ReturnType<typeof useCapabilities>): boolean {
  if (r.scope === "user") return true;
  if (r.scope === "object") return !!r.objectPath && !!r.can?.includes(r.entry.target?.verb ?? "configure");
  return settingsEntryVisible(caps, r.entry);
}

// The group heading a scope gets in the menu. Headings only render when a menu mixes scopes.
const SCOPE_LABEL: Record<SettingsScope, string> = { org: "For everyone", object: "For this item", user: "Just for me" };
const SCOPE_ORDER: SettingsScope[] = ["object", "org", "user"];

// The single settings affordance for a surface (a page header, a tab band, a board toolbar): one gear. With
// several settings it opens a menu of labelled rows (icon, title, one-line description), so nobody has to hover
// a row of look-alike icons to find the right one. With exactly one it opens that panel straight away. With
// none the caller may open, it renders nothing.
// Every panel opens inline in a right-docked Sheet - the SAME panel as the central Settings hub, no navigation
// away. Open state is deep-linked via `?setting=<key>` (+ `?settingObj=<objectPath>` for object scope) on the
// page hash, so it is shareable and the back button closes it.
export function SettingsMenu({ me, items }: { me: Me; items: SettingsItem[] }) {
  const caps = useCapabilities();
  const route = useRoute();
  // Set when a menu row opened a sheet, so the menu doesn't pull focus back to its trigger out from under it.
  const opening = React.useRef(false);

  const visible: Resolved[] = [];
  for (const it of items) {
    const entry = settingsEntry(it.key);
    if (!entry) continue;
    const r: Resolved = { entry, scope: entryScope(entry), objectPath: it.objectPath, can: it.can };
    if (canOpenSetting(r, caps)) visible.push(r);
  }
  if (visible.length === 0) return null;

  // Object scope keys the open state on both the setting AND which instance, so a sheet is open only for the
  // instance whose path is in the URL (switching the selected board closes a stale sheet).
  const isOpen = (r: Resolved) =>
    route.query.setting === r.entry.key && (r.scope !== "object" || route.query.settingObj === r.objectPath);
  const openSheet = (r: Resolved) =>
    r.scope === "object"
      ? setQueryParams({ setting: r.entry.key, settingObj: r.objectPath! })
      : setQueryParam("setting", r.entry.key);
  const closeSheet = () => setQueryParams({ setting: null, settingObj: null });

  // One Sheet per item, mounted closed, so closing plays its exit animation instead of vanishing.
  const sheet = visible.map((r) => (
    <SettingsSheet key={r.entry.key + (r.objectPath ?? "")} me={me} item={r} open={isOpen(r)} onOpen={() => openSheet(r)} onClose={closeSheet} />
  ));

  if (visible.length === 1) {
    const only = visible[0];
    const Icon = only.entry.icon;
    return (
      <>
        <Button variant="outline" size="icon" title={only.entry.title} aria-label={only.entry.title} onClick={() => openSheet(only)}>
          <Icon className="h-4 w-4" />
        </Button>
        {sheet}
      </>
    );
  }

  const scopes = SCOPE_ORDER.filter((s) => visible.some((r) => r.scope === s));
  return (
    <TooltipProvider delayDuration={300}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" title="Settings" aria-label="Settings">
            <Settings2 className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => {
            if (opening.current) e.preventDefault();
            opening.current = false;
          }}
        >
          {scopes.map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <DropdownMenuSeparator />}
              {scopes.length > 1 && (
                <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{SCOPE_LABEL[s]}</DropdownMenuLabel>
              )}
              {visible.filter((r) => r.scope === s).map((r) => {
                const Icon = r.entry.icon;
                // The row is just icon + title; the one-line description shows on hover (and on keyboard focus),
                // beside the menu rather than under the row. Touch has no hover, and the panel header repeats it.
                return (
                  <Tooltip key={r.entry.key + (r.objectPath ?? "")}>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        onSelect={() => {
                          opening.current = true;
                          openSheet(r);
                        }}
                      >
                        <Icon className="shrink-0 text-muted-foreground" />
                        {r.entry.title}
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    <TooltipContent side="left">{r.entry.desc}</TooltipContent>
                  </Tooltip>
                );
              })}
            </React.Fragment>
          ))}
          {scopes.includes("org") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("settings")}>
                <ExternalLink className="text-muted-foreground" /> All settings
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {sheet}
    </TooltipProvider>
  );
}

// One item's panel. `open` is derived from the URL; the panel body mounts only while open, so a closed sheet
// never loads the Settings chunk.
function SettingsSheet({ me, item, open, onOpen, onClose }: { me: Me; item: Resolved; open: boolean; onOpen: () => void; onClose: () => void }) {
  const { entry, scope, objectPath, can } = item;
  const route = useRoute();
  const { toast } = useToast();
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);

  // Object scope resolves the ACL target at runtime (the registry can't know the instance path).
  const target: AccessTargetRef | undefined =
    scope === "object" && entry.target
      ? { ...entry.target, objectPath, can }
      : entry.target;

  return (
    <Sheet open={open} onOpenChange={(o) => (o ? onOpen() : onClose())}>
      {/* A two-pane panel (list rail + editor) needs more than the 760px default, or the rail starves the
          editor. Still capped by the viewport, so a laptop just gets the widest panel that fits. */}
      {/* `routed`: this panel's open state IS the URL (`?setting=`), so Back already closes it. */}
      <SheetContent routed className={entry.wide ? "sm:max-w-[min(1100px,95vw)]" : undefined}>
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
              <SettingsPanelContent entryKey={entry.key} me={me} toast={toast} slot={slot} openId={route.query.settingItem} objectPath={objectPath} onClose={onClose} />
            </React.Suspense>
          )}
        </SheetBody>
        {/* Org singletons deep-link to their full settings page; a floating corner icon (not a footer row), so
            the panel keeps its full width and height for content. */}
        {scope === "org" && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="absolute bottom-4 right-4 z-20 rounded-full text-muted-foreground shadow-md"
                  aria-label="Open full settings"
                  onClick={() => navigate(`settings/${entry.key}`)}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Open full settings</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </SheetContent>
    </Sheet>
  );
}

// One setting on its own - a board's config, the tag printer's knobs. The same affordance as a menu of one.
export function SettingsButton({ me, settingKey, objectPath, can }: { me: Me; settingKey: string; objectPath?: string; can?: string[] }) {
  return <SettingsMenu me={me} items={[{ key: settingKey, objectPath, can }]} />;
}

// Drop-in for a page header's `actions` slot: the settings mapped to this host page (registry HOST_SETTINGS),
// as one menu. One mechanism for every wired page - add a map row, not JSX. HOST_SETTINGS is org-scoped only;
// `extra` carries the object/user settings a page adds itself, since those need an instance path or a caller.
export function PageSettings({ me, host, extra }: { me: Me; host: string; extra?: SettingsItem[] }) {
  return <SettingsMenu me={me} items={[...hostSettings(host).map((key) => ({ key })), ...(extra ?? [])]} />;
}
