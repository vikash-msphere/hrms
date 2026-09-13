import { Suspense, useEffect, useMemo, useRef, useState } from "react";
// lazyPage, not React.lazy: a failed import must stay retryable (see lib/lazyPage.tsx and the crash boundary).
import { lazyPage as lazy } from "@/lib/lazyPage";
import { navigate } from "@/router";
import { Plus, Trash2, Save, Building, X, ChevronDown, Users, User, Search, ArrowLeft, ArrowUp, ArrowDown, Check, Globe, Palette, Type, Image as ImageIcon } from "lucide-react";
import { get, patch, create, remove, list, dataUrl } from "@/api";
import { SETTINGS_REGISTRY, SETTINGS_GROUPS, SETTINGS_LEGACY, settingsEntry, entryScope, type SettingsEntry } from "@/settings/registry";
import { hasCapability } from "@/lib/perm";
import { APP_NAME } from "@/lib/brand";
import type { OrgSettings } from "@/lib/org";
import { roleLabel } from "@/lib/roles";
import { type Audience, type DashboardConfig, type KpiCategory, KPI_DEFS, KPI_CATEGORIES, KPI_DEFAULT_AUDIENCE, MARKER_DEFS } from "@/lib/dashboardConfig";
import { KPI_ICONS, CATEGORY_ICONS } from "@/lib/kpiIcons";
import { usePermission } from "@/lib/perm";
import { useOrg, currencyDecimals, orgNameFontStack, orgNameWeight, orgNameSizePx, NAME_FONTS, NAME_WEIGHTS, NAME_SIZES, type LetterDefaults } from "@/lib/org";
import { useCollection } from "@/hooks/useCollection";
import { useLetterheads } from "@/lib/letterheads";
import { LetterheadDesigner } from "@/components/settings/LetterheadDesigner";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";
import { SplitStaleBanner } from "@/components/common/SplitStaleBanner";
import { cn, idOf, formatMoney } from "@/lib/utils";
import { useRowKeys } from "@/lib/rowKeys";
import { describeError, isConflict } from "@/lib/formError";
import { thisYearStr, setOrgTimezone } from "@/lib/orgDay";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { EmployeeFieldDef, Employee, Department, TicketCategory, TicketChecklist, Letterhead, Me, AtsConfig, AtsStage, Automation } from "@/types";
import { DEFAULT_ATS_CONFIG } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelSkeleton, RowsSkeleton } from "@/components/common/Skeletons";
import { UnsavedScope, useUnsaved, useUnsavedTracker } from "@/components/common/UnsavedChanges";
import { Field, FieldRow } from "@/components/common/Field";
import { AccessTarget } from "@/components/access/AccessTarget";
import { AccessAction } from "@/components/access/AccessAction";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
// ---- Panels: every one of them lazy ------------------------------------------------------------------------
//
// Nobody opens fifty settings panels. They open one. Importing them statically made Settings a single 320 kB
// chunk - four times the next-largest page - so opening "Employee IDs" downloaded the payslip designer, the
// board config editor, the permissions matrix and every catalog admin with it. Three of them were already lazy
// on exactly this reasoning (the xlsx parser, the letter editor, the payslip editor); the argument was never
// specific to those three.
//
// `renderSettingsPanel` wraps the whole switch in ONE Suspense, so a panel becoming lazy needs no change at any
// call site - and the settings hub itself (cards, search, the command palette) reads metadata from
// settings/registry.ts, which stays a static import precisely so it costs nothing.
const GoalTemplates = lazy(() => import("@/pages/GoalTemplates"));
const PayComponents = lazy(() => import("@/pages/PayComponents"));
const PayGradesAdmin = lazy(() => import("@/pages/PayGradesAdmin"));
const SalaryStructuresAdmin = lazy(() => import("@/pages/SalaryStructuresAdmin"));
const BankFormats = lazy(() => import("@/pages/BankFormats"));
const LettersTab = lazy(() => import("@/pages/LettersTab"));
const PayslipDesignTab = lazy(() => import("@/pages/PayslipDesignTab"));
const LeaveTypes = lazy(() => import("@/pages/LeaveTypes"));
const ReviewCycles = lazy(() => import("@/pages/ReviewCycles"));
const BenefitPlansAdmin = lazy(() => import("@/pages/BenefitPlansAdmin"));
const ShiftsAdmin = lazy(() => import("@/pages/ShiftsAdmin"));
const ProjectsAdmin = lazy(() => import("@/pages/ProjectsAdmin"));
const Departments = lazy(() => import("@/pages/Departments"));
const ReimbursementCategories = lazy(() => import("@/pages/ReimbursementCategories"));
const ExpenseCategories = lazy(() => import("@/pages/ExpenseCategories"));
const AssetCategories = lazy(() => import("@/pages/AssetCategories"));
const Operations = lazy(() => import("@/pages/Operations"));
// Named exports, so the module has to be re-shaped into the `{ default }` lazy() expects.
const BoardConfigPanel = lazy(() => import("@/settings/BoardConfigPanel").then((m) => ({ default: m.BoardConfigPanel })));
const NotificationPrefsPanel = lazy(() => import("@/components/notifications/NotificationPrefsPanel").then((m) => ({ default: m.NotificationPrefsPanel })));
const KudosLevelsTab = lazy(() => import("@/components/common/KudosLevelsTab").then((m) => ({ default: m.KudosLevelsTab })));
const RolesPanel = lazy(() => import("@/components/common/RolesPanel").then((m) => ({ default: m.RolesPanel })));
const RolesManagePanel = lazy(() => import("@/components/common/RolesManagePanel").then((m) => ({ default: m.RolesManagePanel })));
const ApiKeysPanel = lazy(() => import("@/components/common/ApiKeysPanel").then((m) => ({ default: m.ApiKeysPanel })));
const PermissionsPanel = lazy(() => import("@/components/common/PermissionsPanel").then((m) => ({ default: m.PermissionsPanel })));
const PerformanceFramework = lazy(() => import("@/components/common/PerformanceFramework").then((m) => ({ default: m.PerformanceFramework })));
const TransitionTemplatesEditor = lazy(() => import("@/components/common/TransitionTemplatesEditor").then((m) => ({ default: m.TransitionTemplatesEditor })));
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { CONFIGURABLE_QUICK_ACTIONS, normalizeQuickMenu, type QuickMenuGroup } from "@/lib/quickActions";
import { shortcutCatalog, DEFAULT_DASHBOARD_SHORTCUTS } from "@/lib/dashboardShortcuts";
import { SHEET_FORMATS, FALLBACK_TAG_CODE, DEFAULT_TAG_SETTINGS, allFormats, resolveTagConfig, formatTag, type AssetTagSettings, type AssetCustodySettings, type SheetFormat } from "@/lib/assetTags";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ShieldAlert } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { getSetting, saveSetting } from "@/lib/settingsStore";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * The failure toast every settings panel's Save runs through.
 *
 * `saveSetting` is the one write path in the app that sends an `If-Match`, so these panels are where a lost
 * race is actually DETECTED - and the only place that did nothing with it. The panels toasted the generic
 * "someone else changed this, reload the page" line and left Save live over the losing version; pressing it
 * again SUCCEEDS, because the 409 made `saveSetting` drop the snapshot and the retry picks up the winner's
 * fresh etag - writing this panel's whole blob over theirs, which for a ticket-category list or a kudos ladder
 * is a section of config replaced with no sign anything was lost.
 *
 * A settings blob has no field-level merge to offer, so the overwrite stays available. What changes is that it
 * is stated: press Save again and you replace their version, or reload and see what they changed first.
 */
/**
 * Several independent settings keys under one Save, with a resume point.
 *
 * A panel that writes four keys in sequence under one try/catch fails halfway SILENTLY: the first two are
 * committed and in force while the toast says the save did not happen. On the leave panel that is a live policy
 * split down the middle - carry-forward caps and the encashment rate basis applying, accrual rounding and
 * back-dating not - with the admin told nothing changed.
 *
 * So: report which keys landed, and remember them keyed by the exact value that landed, so pressing Save again
 * finishes the job instead of rewriting what is already in force (and re-running the If-Match risk on a key
 * that is already correct). A key whose value has since been edited is written again, because its stored copy
 * is no longer what the panel is asking for.
 */
type SettingWrite = { key: string; label: string; value: unknown };
type BatchResult = { ok: true } | { ok: false; error: unknown; written: string[] };

function useSettingsBatch(): (writes: SettingWrite[]) => Promise<BatchResult> {
  const landed = useRef(new Map<string, string>());
  return async (writes: SettingWrite[]) => {
    const written: string[] = [];
    for (const w of writes) {
      const json = JSON.stringify(w.value) ?? "";
      if (landed.current.get(w.key) === json) continue; // already written, unchanged since
      try {
        await saveSetting(w.key, { value: w.value });
      } catch (error) {
        return { ok: false, error, written };
      }
      landed.current.set(w.key, json);
      written.push(w.label);
    }
    return { ok: true };
  };
}

/** The partial-save toast: the failure, plus what did land and what pressing Save again will do. */
function batchError(r: { error: unknown; written: string[] }): { variant: "destructive"; title: string; description: string } {
  const base = saveSettingError(r.error);
  if (!r.written.length) return base;
  const list = r.written.join(", ");
  return {
    ...base,
    title: "Saved in part",
    description: `${base.description} ${list} ${r.written.length === 1 ? "was" : "were"} saved and ${r.written.length === 1 ? "is" : "are"} already in force; press Save again to finish the rest.`,
  };
}

function saveSettingError(e: unknown): { variant: "destructive"; title: string; description: string } {
  return isConflict(e)
    ? {
        variant: "destructive",
        title: "Somebody else changed this",
        description: "Another admin saved this section while you had it open. Your version is still on screen: press Save again to replace theirs, or reload the page to see what they changed first.",
      }
    : { variant: "destructive", title: "Couldn't save", description: describeError(e) };
}
const DEFAULT_FIELDS: EmployeeFieldDef[] = [
  { key: "pan", label: "PAN", mandatory: false, sensitive: true },
  { key: "aadhaar", label: "Aadhaar", mandatory: false, sensitive: true },
  { key: "uan", label: "UAN", mandatory: false, sensitive: false },
];

// Mirror of src/domain/notificationConfig.ts (kept in sync by hand - small + stable). Drives the config UI.
const NOTIF_CATEGORIES: { key: string; label: string; defaultPriority: string }[] = [
  { key: "leave", label: "Leave decisions", defaultPriority: "normal" },
  { key: "reimbursement", label: "Reimbursements", defaultPriority: "normal" },
  { key: "loan", label: "Loans & advances", defaultPriority: "normal" },
  { key: "overtime", label: "Overtime", defaultPriority: "normal" },
  { key: "remote", label: "Remote work", defaultPriority: "normal" },
  { key: "regularization", label: "Attendance regularization", defaultPriority: "normal" },
  { key: "encashment", label: "Leave encashment", defaultPriority: "normal" },
  { key: "timesheet", label: "Timesheets", defaultPriority: "normal" },
  { key: "kudos", label: "Kudos", defaultPriority: "normal" },
  { key: "suggestion", label: "Suggestions", defaultPriority: "normal" },
  { key: "announcement", label: "Announcements", defaultPriority: "normal" },
  { key: "document", label: "Documents (review / sign)", defaultPriority: "high" },
  { key: "payslip", label: "Payslips", defaultPriority: "normal" },
  { key: "tax", label: "Tax declarations", defaultPriority: "normal" },
  { key: "transition", label: "Onboarding / offboarding", defaultPriority: "high" },
  { key: "ticket", label: "Support tickets", defaultPriority: "normal" },
  { key: "review", label: "Performance reviews", defaultPriority: "normal" },
  { key: "goal", label: "Goals", defaultPriority: "normal" },
  { key: "checkin", label: "Check-ins / 1:1s", defaultPriority: "normal" },
  { key: "compliance", label: "Compliance calendar", defaultPriority: "high" },
  { key: "referral", label: "Referrals", defaultPriority: "normal" },
  { key: "bonus", label: "Bonuses", defaultPriority: "normal" },
  { key: "benefit", label: "Benefits", defaultPriority: "normal" },
  { key: "board", label: "Boards & cards", defaultPriority: "normal" },
  { key: "notice", label: "Notice periods", defaultPriority: "high" },
  { key: "settlement", label: "Final settlement", defaultPriority: "high" },
  { key: "asset", label: "Assets", defaultPriority: "normal" },
  { key: "shift", label: "Shifts & roster", defaultPriority: "normal" },
  { key: "recruiting", label: "Recruiting", defaultPriority: "normal" },
  { key: "compensation", label: "Compensation", defaultPriority: "high" },
  { key: "system", label: "System", defaultPriority: "normal" },
];
const NOTIF_PRIORITIES = ["low", "normal", "high", "urgent"];

type EventCfg = { enabled: boolean; priority: string };
function NotificationsTab({ toast }: { toast: Toast }) {
  const [events, setEvents] = useState<Record<string, EventCfg>>({});
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getSetting<{ events?: Record<string, EventCfg> }>("notifications")
      .then((s) => setEvents(s.value?.events ?? {}))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  const cfgOf = (c: { key: string; defaultPriority: string }): EventCfg => events[c.key] ?? { enabled: true, priority: c.defaultPriority };
  const setOne = (key: string, patchCfg: Partial<EventCfg>, def: string) =>
    setEvents((e) => ({ ...e, [key]: { ...(e[key] ?? { enabled: true, priority: def }), ...patchCfg } }));
  const [saving, setSaving] = useState(false);
  const { markSaved } = useUnsaved(events, ready, save);
  async function save() {
    setSaving(true);
    try {
      // Materialize every category so the saved blob is complete + explicit.
      const full = Object.fromEntries(NOTIF_CATEGORIES.map((c) => [c.key, cfgOf(c)]));
      await saveSetting("notifications", { value: { events: full } });
      markSaved();
      toast({ title: "Notification settings saved" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally { setSaving(false); }
  }
  if (!ready) return <Card><CardContent className="pt-6"><RowsSkeleton rows={7} /></CardContent></Card>;
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction collection="settings" objectPath="settings/notifications" label="Notification settings"><span>In-app notifications</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="mb-4 text-sm text-muted-foreground">Turn an event category on or off for everyone, and set its priority. Urgent and high items float to the top of the bell and are highlighted. Disabling a category stops those notifications being created.</p>
        <div className="divide-y">
          {NOTIF_CATEGORIES.map((c) => {
            const cur = cfgOf(c);
            return (
              <div key={c.key} className="flex items-center justify-between gap-4 py-2.5">
                <label className="flex flex-1 items-center gap-3">
                  <input type="checkbox" checked={cur.enabled} onChange={(e) => setOne(c.key, { enabled: e.target.checked }, c.defaultPriority)} className="h-4 w-4 accent-primary" />
                  <span className={cn("text-sm", !cur.enabled && "text-muted-foreground line-through")}>{c.label}</span>
                </label>
                <Select value={cur.priority} onValueChange={(v) => setOne(c.key, { priority: v }, c.defaultPriority)} disabled={!cur.enabled}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {NOTIF_PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
        <div className="pt-4"><Button onClick={save} loading={saving}>Save</Button></div>
      </CardContent>
    </Card>
  );
}

// ============================== Settings shell ==============================
// No tab hierarchy. A hub (search + grouped cards + setup checklist) at `settings`, and one full-width
// panel per topic at `settings/<key>` with a persistent left rail for sideways hops. The registry
// (src/settings/registry.ts) is the single source of truth for keys, labels, grouping, gating and search.

const canSee = (me: Me, e: SettingsEntry) => !e.perm || hasCapability(me.capabilities, e.perm);

// Opening a settings entry: org singletons open their panel page; non-org entries (per-board, per-user) have
// no instance here, so the card/rail item is a nav card that jumps to the host page where the inline gear lives.
const goToEntry = (e: SettingsEntry) => navigate(entryScope(e) === "org" ? `settings/${e.key}` : e.hostPage ?? "dashboard");

// Single search predicate shared by the hub search box and the panel rail search box: title, description,
// group and keyword synonyms all count as matchable text.
const settingsMatch = (e: SettingsEntry, ql: string) =>
  [e.title, e.desc, e.group, ...(e.keywords ?? [])].join(" ").toLowerCase().includes(ql);

export default function Settings({ me, tab, openId }: { me: Me; tab?: string; openId?: string }) {
  const writable = usePermission("settings.write");
  const { toast } = useToast();

  if (!writable) {
    return (
      <div>
        <PageHeader title="Settings" />
        <EmptyState icon={ShieldAlert} title="Restricted" description="You don't have access to organization settings." />
      </div>
    );
  }

  const key = tab ? SETTINGS_LEGACY[tab] ?? tab : undefined;
  const entry = key ? settingsEntry(key) : undefined;
  if (!entry || !canSee(me, entry)) return <SettingsHub me={me} />;
  // Non-org settings have no single instance to edit here; they live on their host page. Bounce there.
  if (entryScope(entry) !== "org") return <SettingsRedirect entry={entry} />;
  return <SettingsPanel me={me} entry={entry} toast={toast} openId={openId} />;
}

// A direct hit on #/settings/<non-org-key> has no instance to configure; send the user to the host page where
// the real inline gear lives (opening the setting there once a board is selected).
function SettingsRedirect({ entry }: { entry: SettingsEntry }) {
  useEffect(() => { navigate(entry.hostPage ?? "dashboard"); }, [entry.hostPage]);
  return null;
}

// ----- Hub: search-first browse surface + greenfield setup checklist -----

// Setup essentials a fresh org must configure before the app is genuinely usable. Each probe asks one
// question - "is there anything here at all" - so it asks for ONE ROW, not the page of up to a hundred a
// default read would bring. Four one-row reads (in the page's own batch) instead of four collection pages, on
// a checklist that is only ever shown to an org that hasn't finished setting up. Identity comes from the org
// context that is already loaded app-wide.
const PROBE = { max: 1 } as const;
function useEssentials(me: Me) {
  const { org } = useOrg();
  const depts = useCollection<{ path: string }>("departments", PROBE);
  const leaveTypes = useCollection<{ path: string }>("leave-types", PROBE);
  const payComponents = useCollection<{ path: string }>("pay-components", PROBE);
  const templates = useCollection<{ path: string }>("letter-templates", PROBE);
  const ready = [depts, leaveTypes, payComponents, templates].every((c) => c.state !== "loading");
  const items = [
    { key: "identity", label: "Set your company name & logo", done: !!org.logo || !!org.address || (!!org.name && org.name !== APP_NAME) },
    { key: "departments", label: "Create departments", done: depts.rows.length > 0 },
    { key: "leave-types", label: "Add leave types", done: leaveTypes.rows.length > 0 },
    { key: "pay-components", label: "Define pay components", done: payComponents.rows.length > 0 },
    { key: "letters", label: "Add letter templates", done: templates.rows.length > 0 },
  ].filter((i) => canSee(me, settingsEntry(i.key)!));
  return { ready, items };
}

function SettingsHub({ me }: { me: Me }) {
  const visible = SETTINGS_REGISTRY.filter((e) => canSee(me, e));
  const [q, setQ] = useState("");
  const { ready, items } = useEssentials(me);
  const missing = items.filter((i) => !i.done);
  const ql = q.trim().toLowerCase();
  const matches = ql ? visible.filter((e) => settingsMatch(e, ql)) : visible;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Settings" description="Everything about how the app works for your org. Search to find any setting." />
      <div className="relative mb-6 max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search settings - try "leave", "logo", "tax", "roles"…' className="h-11 rounded-xl pl-9" />
      </div>

      {/* Setup checklist: only while something's missing, and only the bits this caller can actually fix. */}
      {ready && missing.length > 0 && !ql && (
        <div className="mb-8 rounded-xl border border-primary/30 bg-primary/5 p-4 dark:bg-primary/10">
          <p className="mb-2 text-sm font-medium">Finish setting up · {items.length - missing.length} of {items.length} essentials done</p>
          <div className="flex flex-wrap gap-2">
            {missing.map((i) => (
              <Button key={i.key} variant="outline" size="sm" onClick={() => navigate(`settings/${i.key}`)}>{i.label}</Button>
            ))}
          </div>
        </div>
      )}

      {ql ? (
        matches.length === 0 ? (
          <EmptyState icon={Search} title="No settings match" description={`Nothing matches "${q.trim()}". Try another word - descriptions and synonyms are searched too.`} />
        ) : (
          <SettingsCardGrid entries={matches} />
        )
      ) : (
        SETTINGS_GROUPS.map((g) => {
          const list = visible.filter((e) => e.group === g);
          if (list.length === 0) return null;
          return (
            <section key={g} className="mb-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{g}</h2>
              <SettingsCardGrid entries={list} />
            </section>
          );
        })
      )}
    </div>
  );
}

function SettingsCardGrid({ entries }: { entries: SettingsEntry[] }) {
  return (
    // Three across from `lg`: the section cards are short, and a laptop showed two columns of them with a
    // third of the row empty and the list running twice as long as it needed to.
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((e) => {
        const Icon = e.icon;
        return (
          <button
            key={e.key}
            type="button"
            onClick={() => goToEntry(e)}
            className="group flex items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-accent/50 dark:hover:bg-accent/30"
          >
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:bg-primary/15">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{e.title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{e.desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ----- Panel page: left rail + one panel -----

function SettingsPanel({ me, entry, toast, openId }: { me: Me; entry: SettingsEntry; toast: Toast; openId?: string }) {
  // Portal slot on the header line: the access panels (Users/Roles/Permissions) park their control strip
  // here so it doesn't cost a separate row.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [q, setQ] = useState("");
  const visible = SETTINGS_REGISTRY.filter((e) => canSee(me, e));
  const ql = q.trim().toLowerCase();
  const matches = ql ? visible.filter((e) => settingsMatch(e, ql)) : null;

  const railItem = (e: SettingsEntry) => {
    const Icon = e.icon;
    const active = e.key === entry.key;
    return (
      <button
        key={e.key}
        type="button"
        onClick={() => goToEntry(e)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
          active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground dark:hover:bg-accent/30"
        }`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" /> {e.title}
      </button>
    );
  };

  return (
    <div className="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-10">
      <aside className="hidden lg:block">
        {/* Offset by the app bar's own 3.5rem: `top-4` pinned this column behind it, so its first few groups
            were unreachable once the page scrolled. The height budget follows the same offset, and is `dvh`
            so a mobile browser's collapsing chrome does not leave the last entry under the fold. */}
        <nav className="sticky top-[4.5rem] max-h-[calc(100dvh-6rem)] space-y-5 overflow-y-auto pb-4 pr-1">
          <button
            type="button"
            onClick={() => navigate("settings")}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All settings
          </button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings…" className="h-8 rounded-md pl-8 text-sm" />
          </div>
          {matches
            ? matches.length === 0
              ? <p className="px-2 text-sm text-muted-foreground">No matches.</p>
              : <div className="space-y-0.5">{matches.map(railItem)}</div>
            : SETTINGS_GROUPS.map((g) => {
            const list = visible.filter((e) => e.group === g);
            if (list.length === 0) return null;
            return (
              <div key={g}>
                <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{g}</p>
                <div className="space-y-0.5">{list.map(railItem)}</div>
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="min-w-0">
        <div className="lg:hidden">
          <Button variant="ghost" size="sm" className="-ml-2 mb-2 text-muted-foreground" onClick={() => navigate("settings")}>
            <ArrowLeft className="h-4 w-4" /> Settings
          </Button>
        </div>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <h1 className="text-xl font-semibold">{entry.title}</h1>
              {entry.target && <AccessTarget target={entry.target} className="h-6 w-6" />}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{entry.desc}</p>
          </div>
          <div ref={setSlot} className="flex flex-wrap items-center justify-end gap-2" />
        </div>
        <UnsavedScope bannerClassName="top-16">{renderSettingsPanel(entry.key, me, toast, slot, openId)}</UnsavedScope>
      </div>
    </div>
  );
}

const panelLoading = <PanelSkeleton />;

/**
 * One panel, by registry key. Every panel is lazy (see the import block), so the whole switch sits behind a
 * SINGLE Suspense boundary here rather than each case carrying its own - that is what let the remaining panels
 * become lazy without touching this function's four call sites (the panel page, the inline `?setting=` Sheet,
 * and the two deep-link entries).
 */
export function renderSettingsPanel(key: string, me: Me, toast: Toast, slot: HTMLDivElement | null, openId?: string, objectPath?: string, onClose?: () => void) {
  const panel = pickSettingsPanel(key, me, toast, slot, openId, objectPath, onClose);
  return panel === null ? null : <Suspense fallback={panelLoading}>{panel}</Suspense>;
}

/**
 * The lazily-loaded entry point the inline SettingsButton (feature-page gear) imports - the panel body plus
 * the unsaved-changes scope the Settings page wraps its own panel in. It lives HERE, in the chunk it needs,
 * rather than in a module of its own: a wrapper that does nothing but re-export from this page becomes its
 * own 400-byte chunk, and opening the gear then costs a request for it on top of the request for this page.
 *
 * `slot` is the header portal a few Access panels park controls in; `objectPath`/`onClose` are used by
 * object-scoped panels (e.g. a board's config) to know which instance they edit and to dismiss the Sheet
 * after a destructive action.
 */
export function SettingsPanelContent({
  entryKey,
  me,
  toast,
  slot,
  openId,
  objectPath,
  onClose,
}: {
  entryKey: string;
  me: Me;
  toast: Toast;
  slot?: HTMLDivElement | null;
  openId?: string;
  objectPath?: string;
  onClose?: () => void;
}) {
  return <UnsavedScope>{renderSettingsPanel(entryKey, me, toast, slot ?? null, openId, objectPath, onClose)}</UnsavedScope>;
}

function pickSettingsPanel(key: string, me: Me, toast: Toast, slot: HTMLDivElement | null, openId?: string, objectPath?: string, onClose?: () => void) {
  switch (key) {
    // Object-scoped (per instance): opened inline from the object's own page, with its path.
    case "board-config": return objectPath ? <BoardConfigPanel objectPath={objectPath} onClose={onClose} /> : null;
    // User-scoped (per caller): the caller's own preferences.
    case "notification-prefs": return me.employee_id ? <NotificationPrefsPanel employeeId={me.employee_id} /> : null;
    // Company
    case "identity": return <OrgIdentityPanel toast={toast} />;
    case "banks-currency": return <OrgBanksPanel toast={toast} />;
    case "defaults": return <DefaultsTab toast={toast} />;
    case "employee-ids": return <EmployeeIdsTab toast={toast} />;
    case "asset-tags": return <AssetTagsTab toast={toast} openId={openId} />;
    case "departments": return <Departments embedded title="Departments" />;
    case "employee-fields": return <FieldsTab toast={toast} />;
    case "dashboard": return <DashboardTab toast={toast} />;
    case "kudos": return <KudosLevelsTab />;
    case "quick-actions": return <QuickActionsTab toast={toast} />;
    // Time & leave
    case "leave-policy": return <LeaveCapsTab toast={toast} />;
    case "leave-types": return <LeaveTypes embedded title="Leave types" openId={openId} />;
    case "attendance": return <AttendanceTab toast={toast} />;
    case "shifts": return <ShiftsAdmin openId={openId} />;
    // Pay & money
    case "pay-components": return <PayComponents embedded openId={openId} />;
    case "pay-grades": return <PayGradesAdmin embedded openId={openId} />;
    case "salary-structures": return <SalaryStructuresAdmin embedded openId={openId} />;
    case "payroll-policy": return <PayrollPolicyTab toast={toast} />;
    case "payslip-design": return <PayslipDesignTab toast={toast} />;
    case "reimbursements": return <ReimbursementsPanel toast={toast} openId={openId} />;
    case "expenses": return <ExpensesPanel toast={toast} openId={openId} />;
    case "bank-formats": return <BankFormats toast={toast} />;
    case "projects": return <ProjectsAdmin openId={openId} />;
    // Hiring & growth
    case "recruiting": return <AtsTab toast={toast} />;
    case "referrals": return <ReferralsTab toast={toast} />;
    case "performance": return <PerformancePanel />;
    case "goal-templates": return <GoalTemplates embedded openId={openId} />;
    case "onboarding-templates": return <TransitionTemplatesEditor />;
    case "benefit-plans": return <BenefitPlansAdmin openId={openId} />;
    // Comms & support
    case "letters": return <LettersTab toast={toast} />;
    case "letter-defaults": return <OrgLetterDefaultsPanel toast={toast} />;
    case "esign": return <EsignTab toast={toast} />;
    case "notifications": return <NotificationsTab toast={toast} />;
    case "ticket-categories": return <TicketsTab toast={toast} />;
    case "ticket-checklists": return <TicketChecklistsTab toast={toast} />;
    // Access & security
    case "users": return <RolesPanel me={me} controlsSlot={slot} />;
    case "roles": return <RolesManagePanel controlsSlot={slot} />;
    case "permissions": return <PermissionsPanel controlsSlot={slot} />;
    case "api-keys": return <ApiKeysPanel controlsSlot={slot} />;
    case "operations": return <Operations embedded />;
    default: return null;
  }
}

type Toast = ReturnType<typeof useToast>["toast"];

// Performance: the rating framework and the review cycles are two unrelated editors - tabbed rather than
// stacked so neither pushes the other off the fold.
function PerformancePanel() {
  return (
    <Tabs defaultValue="framework">
      <TabsList variant="segmented">
        <TabsTrigger value="framework">Framework</TabsTrigger>
        <TabsTrigger value="cycles">Review cycles</TabsTrigger>
      </TabsList>
      <TabsContent value="framework"><PerformanceFramework /></TabsContent>
      <TabsContent value="cycles"><ReviewCycles embedded /></TabsContent>
    </Tabs>
  );
}

const MAX_LOGO_BYTES = 256 * 1024;
const MAX_FAVICON_BYTES = 64 * 1024; // favicons are tiny; the data URL lives in the settings/organization blob

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The zones the org's calendar day may be set to, from the runtime's own IANA database.
//
// This used to be a free-text input, and the two wrong answers it invited are not equally loud. A name the
// runtime refuses ("Asia/Bombay", "GMT+5:30") makes `Intl.DateTimeFormat` throw wherever the org day is read -
// the attendance clock, the payroll build, the nightly tick - and the value is stored, so it is a persistent
// 500. A name it ACCEPTS but that is not a zone ("IST", "EST") is a fixed offset with no daylight-saving rules:
// nothing errors and the org's day is just wrong. The API now rejects both (src/routes/settings.ts
// validateAttendance); offering only real zones is the half that keeps anyone from having to find that out.
//
// `Intl.supportedValuesOf` is the canonical list and needs no dependency. A browser without it falls back to
// the device zone plus the app default, which is a short list rather than an empty one. The CURRENT value is
// always included even when it is not a zone, so an org already holding a bad one can see it and replace it
// instead of finding the control mysteriously blank.
function timezoneOptions(current: string): ComboboxOption[] {
  // Cast because the project's `lib` predates the Intl Enumeration API's declarations; the guard below is the
  // runtime check either way, since a browser can have the lib and not the function.
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  let zones: string[];
  try {
    zones = supportedValuesOf?.("timeZone") ?? [];
    if (!zones.length) throw new Error("no zone list");
  } catch {
    zones = [...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Kolkata", "UTC"].filter(Boolean))];
  }
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones.map((z) => ({ value: z, label: z }));
}

// E-signature (settings/esign): the master enable switch + Aadhaar vendor (Cashfree) config. The signing
// METHOD is NOT chosen here - it is picked per e-signature block on a template (/letters) or per document
// (/documents): "In-app signature" or "Aadhaar e-Sign". This tab only turns signing on and holds the Aadhaar
// vendor's non-secret config (its config fields come from the server driver registry, GET /v1/esign-providers).
// API keys/secrets live in server env, never here.
type EsignCfg = { enabled: boolean; providers: Record<string, Record<string, string | number>> };
const DEFAULT_ESIGN_CFG: EsignCfg = { enabled: true, providers: {} };
type EsignField = { key: string; label: string; type?: "text" | "number"; hint?: string; placeholder?: string };
type ProviderMeta = { id: string; label: string; requiresAadhaar: boolean; supportsWebhook: boolean; configFields: EsignField[] };

function EsignTab({ toast }: { toast: Toast }) {
  const [cfg, setCfg] = useState<EsignCfg>(DEFAULT_ESIGN_CFG);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getSetting<Partial<EsignCfg>>("esign").then((s) => { if (s.value) setCfg((p) => ({ ...p, ...s.value, providers: s.value!.providers ?? {} })); }).catch(() => {}).finally(() => setReady(true));
    get<{ providers: ProviderMeta[] }>("esign-providers").then((r) => setProviders(r.providers ?? [])).catch(() => {});
  }, []);
  const save = async () => { try { await saveSetting("esign", { value: cfg }); markSaved(); toast({ title: "E-signature settings saved" }); } catch (e) { toast(saveSettingError(e)); } };
  const { markSaved } = useUnsaved(cfg, ready, save);
  // Vendor config only for providers that HAVE config (Aadhaar/Cashfree); the in-app "internal" method has none.
  const vendors = providers.filter((p) => p.configFields.length > 0);
  const setField = (id: string, key: string, v: string | number) => setCfg((c) => ({ ...c, providers: { ...c.providers, [id]: { ...(c.providers[id] ?? {}), [key]: v } } }));

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader><CardTitle className="text-base">E-signature</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">The signing method (In-app signature or Aadhaar e-Sign) is chosen per template on the Letters page and per document on the Documents page. This tab is the master switch plus the Aadhaar vendor's settings. API keys are configured by your administrator in the server environment, not here.</p>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={cfg.enabled} onCheckedChange={(v) => setCfg((c) => ({ ...c, enabled: v === true }))} /> Enable e-signing</label>
          {vendors.map((p) => (
            <div key={p.id} className="space-y-3 rounded-lg border p-3">
              <div className="text-sm font-medium">{p.label} settings</div>
              <div className="grid gap-4 sm:grid-cols-2">
                {p.configFields.map((f) => (
                  <Field key={f.key} label={f.label} hint={f.hint}>
                    <Input
                      type={f.type === "number" ? "number" : "text"}
                      placeholder={f.placeholder}
                      value={String(cfg.providers[p.id]?.[f.key] ?? "")}
                      onChange={(e) => setField(p.id, f.key, f.type === "number" ? Number(e.target.value) : e.target.value)}
                    />
                  </Field>
                ))}
              </div>
              {p.requiresAadhaar && <p className="text-xs text-muted-foreground">{p.label} signs with the employee's Aadhaar OTP; the employee needs an Aadhaar recorded under their identity fields.</p>}
            </div>
          ))}
          <Button size="sm" onClick={save}><Save className="h-4 w-4" /> Save</Button>
        </CardContent>
      </Card>
    </div>
  );
}

// Attendance schedule (settings/attendance): the shift window, grace, working days and timezone used to flag
// late arrivals, early departures and absences across the Attendance feature.
// PT slabs in the order this editor and the server's resolver both assume: ascending by wage bound, with the
// open-ended band (`up_to: null`) last. Neither the settings validator nor the stored blob enforces it.
type PtSlab = { up_to: number | null; amount: number };
const sortSlabs = (slabs: PtSlab[]): PtSlab[] =>
  [...slabs].sort((a, b) => (a.up_to == null ? 1 : b.up_to == null ? -1 : a.up_to - b.up_to));

// Payroll policy: the CTC split + PF wage basis, overtime pricing, Professional Tax slabs, statutory gratuity at
// exit, and the loan-interest perquisite. Each is an independent settings blob (settings/ctc, settings/overtime,
// settings/professional-tax, settings/gratuity, settings/loan-perquisite).
function PayrollPolicyTab({ toast }: { toast: Toast }) {
  const [ctc, setCtc] = useState<{ basic_pct: number; pf_wage_basis: string }>({ basic_pct: 50, pf_wage_basis: "basic" });
  const [gratuity, setGratuity] = useState({ enabled: true, min_years: 5, days_per_year: 15, divisor: 26, exemption_cap: 2000000 });
  const [perq, setPerq] = useState({ enabled: false, sbi_rate_pct: 0, interest_charged_pct: 0, exempt_principal_upto: 20000 });
  // Saving the CTC provisions changes how a stored annual CTC splits, so existing employees' cached splits can
  // go stale - shared signal with the pay-components / salary-structures panels.
  const { canReapply, staleCount, skippedCount, reapplying, reapply: doReapply, promptReapply } = useSplitStaleness();
  const [ot, setOt] = useState({ enabled: false, multiplier: 2, hours_per_month: 200, rate_per_hour: 0 });
  const [pt, setPt] = useState<{ slabs: { up_to: number | null; amount: number }[]; annual_cap: number | null }>({ slabs: [{ up_to: 25000, amount: 0 }, { up_to: null, amount: 200 }], annual_cap: 2500 });
  const [approval, setApproval] = useState({ enabled: false });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.allSettled([
      getSetting<Partial<typeof approval>>("payroll-approval").then((s) => { if (s.value) setApproval((p) => ({ ...p, ...s.value })); }),
      getSetting<Partial<typeof ctc>>("ctc").then((s) => { if (s.value) setCtc((p) => ({ ...p, ...s.value })); }),
      getSetting<Partial<typeof ot>>("overtime").then((s) => { if (s.value) setOt((p) => ({ ...p, ...s.value, rate_per_hour: s.value!.rate_per_hour ?? 0 })); }),
      // SORTED on the way in, ascending with the open-ended band last - the same thing the server's resolver
      // does ("the table is HR-editable settings data, so sort rather than trust the stored order",
      // src/domain/statutory.ts). This editor renders the LAST row as the open-ended top bracket and forces its
      // bound to null on save; for a stored table whose null band was not last - written by an API key, an
      // import, a seed - that silently turned the real top band into `up_to: 0` (a bracket that matches nothing)
      // and promoted whatever happened to be last, changing every payslip's PT line with no diff and no warning.
      getSetting<{ slabs?: { up_to: number | null; amount: number }[]; annual_cap?: number | null }>("professional-tax").then((s) => { if (s.value?.slabs?.length) setPt({ slabs: sortSlabs(s.value.slabs), annual_cap: s.value.annual_cap ?? null }); }),
      getSetting<Partial<typeof gratuity>>("gratuity").then((s) => { if (s.value) setGratuity((p) => ({ ...p, ...s.value })); }),
      getSetting<Partial<typeof perq>>("loan-perquisite").then((s) => { if (s.value) setPerq((p) => ({ ...p, ...s.value })); }),
    ]).then(() => setReady(true));
  }, []);
  // Save the provisions, then offer to re-derive basic + Special Allowance for every current comp row under
  // them (CTC held fixed). Explicit because it shifts take-home org-wide - a config change alone never touches
  // existing rows.
  const saveCtc = async () => {
    try {
      await saveSetting("ctc", { value: ctc });
      markCtcSaved();
      toast({ title: "CTC provisions saved" });
      await promptReapply();
    } catch (e) {
      toast(saveSettingError(e));
    }
  };
  const saveOt = async () => { try { await saveSetting("overtime", { value: { ...ot, rate_per_hour: ot.rate_per_hour > 0 ? ot.rate_per_hour : null } }); markOtSaved(); toast({ title: "Overtime policy saved" }); } catch (e) { toast(saveSettingError(e)); } };
  const savePt = async () => {
    // Sorted again before the positional rewrite below, so the row the editor treats as the top band is the one
    // with the highest bound (or the null one) rather than whichever happens to sit last in the array.
    const ordered = sortSlabs(pt.slabs);
    const slabs = ordered.map((s, i) => ({ up_to: i === ordered.length - 1 ? null : Number(s.up_to) || 0, amount: Number(s.amount) || 0 }));
    const annual_cap = pt.annual_cap == null || !Number.isFinite(pt.annual_cap) ? null : Math.max(0, Number(pt.annual_cap));
    try { await saveSetting("professional-tax", { value: { slabs, annual_cap } }); markPtSaved(); toast({ title: "Professional Tax slabs saved" }); } catch (e) { toast(saveSettingError(e)); }
  };
  const saveGratuity = async () => { try { await saveSetting("gratuity", { value: gratuity }); markGratuitySaved(); toast({ title: "Gratuity policy saved" }); } catch (e) { toast(saveSettingError(e)); } };
  const savePerq = async () => { try { await saveSetting("loan-perquisite", { value: perq }); markPerqSaved(); toast({ title: "Loan perquisite policy saved" }); } catch (e) { toast(saveSettingError(e)); } };
  const saveApproval = async () => { try { await saveSetting("payroll-approval", { value: approval }); markApprovalSaved(); toast({ title: approval.enabled ? "Payroll runs now need a second approver" : "Payroll runs can be approved by the submitter again" }); } catch (e) { toast(saveSettingError(e)); } };
  const { markSaved: markApprovalSaved } = useUnsaved(approval, ready, saveApproval);
  const { markSaved: markGratuitySaved } = useUnsaved(gratuity, ready, saveGratuity);
  const { markSaved: markPerqSaved } = useUnsaved(perq, ready, savePerq);
  const { markSaved: markCtcSaved } = useUnsaved(ctc, ready, saveCtc);
  const { markSaved: markOtSaved } = useUnsaved(ot, ready, saveOt);
  const { markSaved: markPtSaved } = useUnsaved(pt, ready, savePt);
  const setSlab = (i: number, patchSlab: Partial<{ up_to: number | null; amount: number }>) => setPt((p) => ({ ...p, slabs: p.slabs.map((s, j) => (j === i ? { ...s, ...patchSlab } : s)) }));
  const slabKeys = useRowKeys(pt.slabs);

  return (
    <Tabs defaultValue="ctc">
      <TabsList variant="segmented">
        <TabsTrigger value="ctc">CTC split</TabsTrigger>
        <TabsTrigger value="overtime">Overtime</TabsTrigger>
        <TabsTrigger value="pt">Professional Tax</TabsTrigger>
        <TabsTrigger value="gratuity">Gratuity</TabsTrigger>
        <TabsTrigger value="perquisite">Loan perquisite</TabsTrigger>
        <TabsTrigger value="approval">Approval</TabsTrigger>
      </TabsList>

      <TabsContent value="ctc">
        <Card>
          <CardHeader><CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/ctc" label="CTC provisions"><span>CTC provisions</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">How an entered CTC splits into pay. Basic is set as a % of CTC; the rest becomes a Special Allowance after employer contributions are added on top. The employer contributions themselves (gratuity, employer PF/ESI, or any you add) are <a href="#/settings/pay-components" className="underline">pay components</a> of kind "employer contribution" - configured there, not here, including whether each one counts inside CTC or is paid over and above it.</p>
            <SplitStaleBanner staleCount={staleCount} skippedCount={skippedCount} reapplying={reapplying} canReapply={canReapply} onReapply={doReapply} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Basic % of CTC" hint="Basic = this % of monthly CTC. New wage code wants ≥ 50%."><Input type="number" step="1" value={ctc.basic_pct} onChange={(e) => setCtc((c) => ({ ...c, basic_pct: Number(e.target.value) }))} /></Field>
              {/* PF wage composition. "Basic only" is what most Indian payrolls run; "basic + allowances" follows
                  the Supreme Court's Vivekananda Vidyamandir line, where universally-paid allowances are basic
                  wages too. It moves both PF shares, EDLI and admin charges, so it re-solves the CTC split. */}
              <Field label="PF wages" hint="What EPF, EDLI and PF admin charges are computed on. Above the ₹15,000 ceiling the two choices cost the same.">
                <Select value={ctc.pf_wage_basis} onValueChange={(v) => setCtc((c) => ({ ...c, pf_wage_basis: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="basic">Basic only</SelectItem>
                    <SelectItem value="basic_plus">Basic + Special Allowance + flagged allowances</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {ctc.pf_wage_basis === "basic_plus" && (
              <p className="text-xs text-muted-foreground">Which allowances count is per component: tick "Counts as PF wages" on each one in <a href="#/settings/pay-components" className="underline">pay components</a>. HRA, overtime and bonus are excluded by statute - leave them off.</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={saveCtc}><Save className="h-4 w-4" /> Save</Button>
              <AccessAction collection="compensation" verb="reapplySplit" label="re-apply the split to all employees">
                <Button size="sm" variant="outline" onClick={doReapply} disabled={reapplying}>{reapplying ? "Re-applying…" : "Re-apply to all employees"}</Button>
              </AccessAction>
            </div>
            <p className="text-xs text-muted-foreground">Saving changes new revisions only. Re-apply re-derives every current employee's basic + Special Allowance under these provisions, holding each CTC fixed - this shifts take-home org-wide.</p>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="overtime">
        <Card>
          <CardHeader><CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/overtime" label="Overtime policy"><span>Overtime pay</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">When enabled, approved overtime is paid as a taxable earning in the next payroll run.</p>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={ot.enabled} onCheckedChange={(v) => setOt((c) => ({ ...c, enabled: v === true }))} /> Pay overtime via payroll</label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Multiplier" hint="× ordinary hourly wage (statutory 2×). Ignored if a flat rate is set."><Input type="number" step="0.5" value={ot.multiplier} onChange={(e) => setOt((c) => ({ ...c, multiplier: Number(e.target.value) }))} disabled={!ot.enabled} /></Field>
              <Field label="Hours per month" hint="Divisor for the hourly rate from base pay."><Input type="number" value={ot.hours_per_month} onChange={(e) => setOt((c) => ({ ...c, hours_per_month: Number(e.target.value) }))} disabled={!ot.enabled} /></Field>
              <Field label="Flat rate / hour" hint="Optional. Overrides the multiplier path. 0 = derive from base."><Input type="number" value={ot.rate_per_hour} onChange={(e) => setOt((c) => ({ ...c, rate_per_hour: Number(e.target.value) }))} disabled={!ot.enabled} /></Field>
            </div>
            <Button size="sm" onClick={saveOt}><Save className="h-4 w-4" /> Save</Button>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="pt">
        <Card>
          <CardHeader><CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/professional-tax" label="Professional Tax"><span>Professional Tax slabs</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Monthly slabs by gross wage (state-specific). The last row is the open-ended top bracket (and above).</p>
            <div className="space-y-2">
              {pt.slabs.map((s, i) => {
                const last = i === pt.slabs.length - 1;
                // "Up to [amount] → deduct [amount] [x]" is ~400px of stated width plus prose, so on a
                // phone the row wraps after the arrow rather than running off the card.
                return (
                  <div key={slabKeys[i]} className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">Up to</span>
                    {last ? <span className="w-32 text-sm font-medium">and above</span>
                      : <Input type="number" className="w-32" value={s.up_to ?? ""} onChange={(e) => setSlab(i, { up_to: Number(e.target.value) })} />}
                    <span className="text-sm text-muted-foreground">→ deduct</span>
                    <Input type="number" className="w-32" value={s.amount} onChange={(e) => setSlab(i, { amount: Number(e.target.value) })} />
                    {!last && pt.slabs.length > 1 && <Button size="icon" variant="ghost" aria-label="Remove this slab" className="h-8 w-8" onClick={() => setPt((p) => ({ ...p, slabs: p.slabs.filter((_, j) => j !== i) }))}><Trash2 className="h-4 w-4" /></Button>}
                  </div>
                );
              })}
            </div>
            <div className="sm:max-w-xs">
              <Field label="Annual cap" hint="Article 276(2) caps professional tax at ₹2,500 a financial year. Payroll stops charging once the year's collection reaches it. Blank for no cap.">
                <Input type="number" step="100" value={pt.annual_cap ?? ""} onChange={(e) => setPt((p) => ({ ...p, annual_cap: e.target.value === "" ? null : Number(e.target.value) }))} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setPt((p) => ({ ...p, slabs: [...p.slabs.slice(0, -1), { up_to: 0, amount: 0 }, p.slabs[p.slabs.length - 1]!] }))}><Plus className="h-4 w-4" /> Add slab</Button>
              <Button size="sm" onClick={savePt}><Save className="h-4 w-4" /> Save</Button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="gratuity">
        <Card>
          <CardHeader><CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/gratuity" label="Gratuity policy"><span>Gratuity at exit</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Statutory gratuity (Payment of Gratuity Act): 15 days' last-drawn basic per completed year of service, once the qualifying service is met, paid in the full &amp; final settlement and exempt u/s 10(10) up to the ceiling. Turn this off if gratuity is settled outside payroll (an LIC or trust policy) - otherwise the FnF would pay it twice.</p>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={gratuity.enabled} onCheckedChange={(v) => setGratuity((c) => ({ ...c, enabled: v === true }))} /> Pay gratuity in the full &amp; final settlement</label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Qualifying service (years)" hint="Statutory minimum is 5. A part-year over six months counts as a full year."><Input type="number" step="1" value={gratuity.min_years} onChange={(e) => setGratuity((c) => ({ ...c, min_years: Number(e.target.value) }))} disabled={!gratuity.enabled} /></Field>
              <Field label="Days per year" hint="Statutory 15 days' wages per completed year."><Input type="number" step="1" value={gratuity.days_per_year} onChange={(e) => setGratuity((c) => ({ ...c, days_per_year: Number(e.target.value) }))} disabled={!gratuity.enabled} /></Field>
              <Field label="Monthly divisor" hint="Statutory 26 (working days in a month)."><Input type="number" step="1" value={gratuity.divisor} onChange={(e) => setGratuity((c) => ({ ...c, divisor: Number(e.target.value) }))} disabled={!gratuity.enabled} /></Field>
              <Field label="Exemption ceiling" hint="s.10(10) lifetime exemption limit (₹20,00,000). The excess is taxed."><Input type="number" step="1000" value={gratuity.exemption_cap} onChange={(e) => setGratuity((c) => ({ ...c, exemption_cap: Number(e.target.value) }))} disabled={!gratuity.enabled} /></Field>
            </div>
            <Button size="sm" onClick={saveGratuity}><Save className="h-4 w-4" /> Save</Button>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="perquisite">
        <Card>
          <CardHeader><CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/loan-perquisite" label="Loan perquisite"><span>Loan interest concession</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">An interest-free or cheap employer loan is a taxable perquisite (Rule 3(7)(i)): interest at the SBI rate on the outstanding balance, less any interest charged. When enabled, payroll adds the monthly value to the employee's taxable income only - it is never paid or deducted, so take-home changes solely through the extra TDS.</p>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={perq.enabled} onCheckedChange={(v) => setPerq((c) => ({ ...c, enabled: v === true }))} /> Value loan interest concession as a perquisite</label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="SBI rate % (annual)" hint="The rate for this kind of loan as notified on 1 April of the financial year."><Input type="number" step="0.05" value={perq.sbi_rate_pct} onChange={(e) => setPerq((c) => ({ ...c, sbi_rate_pct: Number(e.target.value) }))} disabled={!perq.enabled} /></Field>
              <Field label="Interest charged % (annual)" hint="What the company actually charges. 0 for an interest-free loan."><Input type="number" step="0.05" value={perq.interest_charged_pct} onChange={(e) => setPerq((c) => ({ ...c, interest_charged_pct: Number(e.target.value) }))} disabled={!perq.enabled} /></Field>
              <Field label="Exempt up to (aggregate principal)" hint="Nothing is taxable while the total original loan amount is at or below this (₹20,000)."><Input type="number" step="1000" value={perq.exempt_principal_upto} onChange={(e) => setPerq((c) => ({ ...c, exempt_principal_upto: Number(e.target.value) }))} disabled={!perq.enabled} /></Field>
            </div>
            <Button size="sm" onClick={savePerq}><Save className="h-4 w-4" /> Save</Button>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Four-eyes on the payroll commit (settings/payroll-approval). The same switch PermissionsPanel offers
          for access rules, on the step that moves money - and off by default for the same reason: a single
          payroll admin has nobody else to approve, so the way out of that has to be this switch. */}
      <TabsContent value="approval">
        <Card>
          <CardHeader><CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/payroll-approval" label="Payroll approval"><span>Separate approver</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Approving a run is the point the money commits: it claims the pay period, unlocks the bank file, and cannot be undone except by deleting the run. With this on, whoever submitted a run for review cannot also approve it - a second person has to. If you are the only person who can approve, nobody can approve your runs; turn this back off to unblock.</p>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={approval.enabled} onCheckedChange={(v) => setApproval({ enabled: v === true })} /> A payroll run must be approved by someone other than the person who submitted it</label>
            <Button size="sm" onClick={saveApproval}><Save className="h-4 w-4" /> Save</Button>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

type JoinTier = { max_days: number | null; amount: number };
function ReferralsTab({ toast }: { toast: Toast }) {
  const [trigger, setTrigger] = useState<"joining" | "probation">("probation");
  const [amount, setAmount] = useState("10000");
  const [tiers, setTiers] = useState<JoinTier[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getSetting<{ award_trigger?: string; default_bonus_amount?: number; join_tiers?: JoinTier[] }>("referrals")
      .then((s) => {
        if (s.value?.award_trigger === "joining" || s.value?.award_trigger === "probation") setTrigger(s.value.award_trigger);
        if (typeof s.value?.default_bonus_amount === "number") setAmount(String(s.value.default_bonus_amount));
        if (Array.isArray(s.value?.join_tiers)) setTiers(s.value!.join_tiers!);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  const setTier = (i: number, p: Partial<JoinTier>) => setTiers((t) => t.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const addTier = () => setTiers((t) => [...t, { max_days: 30, amount: Number(amount) || 0 }]);
  const removeTier = (i: number) => setTiers((t) => t.filter((_, j) => j !== i));
  const tierKeys = useRowKeys(tiers);
  const [saving, setSaving] = useState(false);
  const { markSaved } = useUnsaved({ trigger, amount, tiers }, ready, save);
  async function save() {
    setSaving(true);
    try {
      // Keep tiers ordered ascending by max_days (nulls last = catch-all), matching the resolver's expectation.
      const clean = [...tiers].sort((a, b) => (a.max_days ?? Infinity) - (b.max_days ?? Infinity));
      await saveSetting("referrals", { value: { award_trigger: trigger, default_bonus_amount: Number(amount) || 0, join_tiers: clean } });
      markSaved();
      toast({ title: "Referral settings saved" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally { setSaving(false); }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction collection="settings" objectPath="settings/referrals" label="Referral settings"><span>Referral bonuses</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="max-w-xl space-y-4">
        <p className="text-sm text-muted-foreground">When a referred candidate is hired and linked to their new employee record, the referral bonus is awarded automatically once they reach the milestone below, then paid on the referrer's next payroll run.</p>
        <Field label="Award the bonus">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="referral-trigger" checked={trigger === "probation"} onChange={() => setTrigger("probation")} /> After the candidate completes probation</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="referral-trigger" checked={trigger === "joining"} onChange={() => setTrigger("joining")} /> As soon as the candidate joins</label>
          </div>
        </Field>
        <Field label="Default bonus amount" hint="Used when a referral has no explicit amount and no tier matches."><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <div className="space-y-2">
          <p className="text-sm font-medium">Join-speed tiers <span className="font-normal text-muted-foreground">(optional)</span></p>
          <p className="text-xs text-muted-foreground">Vary the bonus by how fast the candidate joins after the offer (offer date &rarr; join date). Leave empty to always use the default. An explicit amount on a referral always wins.</p>
          {/* "Joins within [n] days → [amount] [x]" - same shape as the PT slab row above, same reason
              it has to be allowed to break on a phone. */}
          {tiers.map((t, i) => (
            <div key={tierKeys[i]} className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Joins within</span>
              <Input type="number" min={0} className="w-24" value={t.max_days ?? ""} placeholder="any" onChange={(e) => setTier(i, { max_days: e.target.value === "" ? null : Number(e.target.value) })} />
              <span className="text-sm text-muted-foreground">days &rarr;</span>
              <Input type="number" min={0} className="w-32" value={t.amount} onChange={(e) => setTier(i, { amount: Number(e.target.value) })} />
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => removeTier(i)} aria-label="Remove"><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addTier}><Plus className="h-4 w-4" /> Add tier</Button>
        </div>
        <Button onClick={save} loading={saving} disabled={!ready}>Save</Button>
      </CardContent>
    </Card>
  );
}

const stageSlug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "stage";

function AtsTab({ toast }: { toast: Toast }) {
  const [cfg, setCfg] = useState<AtsConfig>(DEFAULT_ATS_CONFIG);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getSetting<Partial<AtsConfig>>("ats")
      .then((s) => { if (s.value && (s.value.stages?.length || s.value.sources?.length)) setCfg({ ...DEFAULT_ATS_CONFIG, ...s.value }); })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const setStage = (i: number, patchStage: Partial<AtsStage>) => setCfg((c) => ({ ...c, stages: c.stages.map((s, j) => (j === i ? { ...s, ...patchStage } : s)) }));
  // A key that is FREE, not one derived from how many stages there happen to be.
  //
  // `stage_${stages.length + 1}` collides the moment the list has ever shrunk: add a sixth stage (`stage_6`),
  // delete an earlier one, add another, and the length is 5 again - so the new stage is `stage_6` too. An
  // application's stage is stored AS this key, so two stages sharing one are the same stage to everything
  // downstream: the board seeds a column per key and the second overwrites the first (both columns then render
  // the same applications), and `nextStage` resolves by `indexOf`, so `:advance` from either moves to the
  // successor of the FIRST and skips a stage of the pipeline. The server refuses a duplicate now
  // (domain/ats.ts#validateAtsConfig); this is so the panel never produces one to be refused.
  const addStage = () => setCfg((c) => {
    const taken = new Set(c.stages.map((s) => s.key));
    let n = c.stages.length + 1;
    while (taken.has(`stage_${n}`)) n++;
    return { ...c, stages: [...c.stages, { key: `stage_${n}`, label: "New stage", kind: "active" }] };
  });
  const removeStage = (i: number) => setCfg((c) => ({ ...c, stages: c.stages.filter((_, j) => j !== i) }));
  const moveStage = (i: number, dir: -1 | 1) => setCfg((c) => {
    const j = i + dir; if (j < 0 || j >= c.stages.length) return c;
    const st = [...c.stages]; [st[i], st[j]] = [st[j]!, st[i]!]; return { ...c, stages: st };
  });
  // Keyed by row identity, not position: a stage row carries a focused text input and a ↑/↓ pair on the same
  // line, so an index key left the caret sitting on whichever row slid into that slot.
  const stageKeys = useRowKeys(cfg.stages);

  const [saving, setSaving] = useState(false);
  const { markSaved } = useUnsaved(cfg, ready, save);
  async function save() {
    // Freeze a stable key per stage from its label (keep an existing key so live applications keep their stage),
    // and make it unique - the same pass BoardConfigPanel runs over a board's columns, for the same reason: the
    // key is the stored identity, so two stages may not share one. A collision can only come from a key derived
    // here (an existing one is already distinct), so suffixing is safe for live applications.
    const taken = new Set<string>();
    const stages = cfg.stages.map((s) => {
      let key = s.key || stageSlug(s.label);
      while (taken.has(key)) key = `${key}_`;
      taken.add(key);
      return { ...s, key, label: s.label.trim() || key };
    });
    // COUNTED, not tested for existence. The panel's own rule is "exactly one", and a second Hired stage is the
    // terminal-shaped version of the duplicate-key failure the loop above guards against: the board renders two
    // terminal columns, a recruiter can drag a candidate into the second, and the server's `:hire` /
    // `offers:accept` resolve `stages.find(kind === "hired")` - the FIRST one - so the record lands at the end
    // nobody chose.
    const hired = stages.filter((s) => s.kind === "hired").length;
    if (hired !== 1) {
      toast({
        variant: "destructive",
        title: hired === 0 ? "Add a Hired stage" : "Only one stage can be Hired",
        description: hired === 0
          ? "One stage must have kind Hired (the success terminal)."
          : `${hired} stages are marked Hired. Reaching any of them should mean the same thing, so exactly one may be the success terminal.`,
      });
      return;
    }
    setSaving(true);
    try {
      await saveSetting("ats", { value: {
        stages,
        sources: cfg.sources.filter(Boolean),
        rejection_reasons: cfg.rejection_reasons.filter(Boolean),
        scorecard_criteria: cfg.scorecard_criteria.filter((c) => c.label.trim()),
        blind_scorecards: cfg.blind_scorecards,
        offer_validity_days: cfg.offer_validity_days,
        join_notice_days: cfg.join_notice_days,
        offer_band_point: cfg.offer_band_point,
      } });
      markSaved();
      toast({ title: "Recruiting settings saved" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally { setSaving(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction collection="settings" objectPath="settings/ats" label="Recruiting settings"><span>Recruiting pipeline</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="max-w-2xl space-y-6">
        <Tabs defaultValue="pipeline">
          <TabsList variant="segmented">
            <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
            <TabsTrigger value="offers">Offers & automation</TabsTrigger>
            <TabsTrigger value="sources">Sources & reasons</TabsTrigger>
            <TabsTrigger value="scorecards">Scorecards</TabsTrigger>
          </TabsList>

          <TabsContent value="pipeline" className="space-y-2">
            <p className="text-sm font-medium">Pipeline stages</p>
            <p className="text-xs text-muted-foreground">The ordered columns of the hiring board. Mark exactly one stage as <b>Hired</b> (reaching it marks the candidate hired).</p>
            <div className="space-y-2">
              {cfg.stages.map((s, i) => (
                <div key={stageKeys[i]} className="editor-row">
                  <Input className="editor-row-main" value={s.label} onChange={(e) => setStage(i, { label: e.target.value })} placeholder="Stage name" />
                  <Select value={s.kind} onValueChange={(v) => setStage(i, { kind: v as AtsStage["kind"] })}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="hired">Hired</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => moveStage(i, -1)} disabled={i === 0} aria-label="Move up">↑</Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => moveStage(i, 1)} disabled={i === cfg.stages.length - 1} aria-label="Move down">↓</Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => removeStage(i)} aria-label="Remove"><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={addStage}><Plus className="h-4 w-4" /> Add stage</Button>
          </TabsContent>

          {/* What a stage move does, and the numbers it does it with. The rules themselves live in Workflows;
              this is where the figures they fill in are set, and where the pipeline explains itself. */}
          <TabsContent value="offers" className="space-y-4">
            <FieldRow>
              <Field label="Offer validity" hint="Days an offer stands before it expires.">
                <Input type="number" min={1} value={cfg.offer_validity_days} onChange={(e) => setCfg((c) => ({ ...c, offer_validity_days: Math.max(1, Number(e.target.value) || 1) }))} />
              </Field>
              <Field label="Notice period assumed" hint="Days from drafting to the proposed start date.">
                <Input type="number" min={0} value={cfg.join_notice_days} onChange={(e) => setCfg((c) => ({ ...c, join_notice_days: Math.max(0, Number(e.target.value) || 0) }))} />
              </Field>
            </FieldRow>
            <Field
              label="Figure to propose"
              hint={cfg.offer_band_point === "none"
                ? "A drafted offer is left blank for whoever approves it to price."
                : "Taken from the requisition's pay band. A requisition with no band leaves the figure blank."}
            >
              <Select value={cfg.offer_band_point} onValueChange={(v) => setCfg((c) => ({ ...c, offer_band_point: v as AtsConfig["offer_band_point"] }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mid">Band midpoint</SelectItem>
                  <SelectItem value="min">Band minimum</SelectItem>
                  <SelectItem value="max">Band maximum</SelectItem>
                  <SelectItem value="none">Leave it blank</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <StageAutomationPreview stages={cfg.stages} />
          </TabsContent>

          <TabsContent value="sources" className="space-y-4">
            <Field label="Candidate sources" hint="One per line.">
              <Textarea rows={4} value={cfg.sources.join("\n")} onChange={(e) => setCfg((c) => ({ ...c, sources: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) }))} />
            </Field>
            <Field label="Rejection reasons" hint="One per line.">
              <Textarea rows={4} value={cfg.rejection_reasons.join("\n")} onChange={(e) => setCfg((c) => ({ ...c, rejection_reasons: e.target.value.split("\n").filter((x) => x.trim().length > 0) }))} />
            </Field>
          </TabsContent>

          <TabsContent value="scorecards" className="space-y-4">
            <Field label="Interview scorecard criteria" hint="One per line. Each becomes a 1-5 rating on interview scorecards.">
              <Textarea rows={4} value={cfg.scorecard_criteria.map((c) => c.label).join("\n")} onChange={(e) => setCfg((c) => ({ ...c, scorecard_criteria: e.target.value.split("\n").filter((x) => x.trim()).map((label) => ({ key: stageSlug(label), label: label.trim() })) }))} />
            </Field>
            <label className="flex items-start gap-2 rounded-lg border p-3">
              <Checkbox checked={cfg.blind_scorecards} onCheckedChange={(v) => setCfg((c) => ({ ...c, blind_scorecards: v === true }))} className="mt-0.5" />
              <span>
                <span className="text-sm font-medium">Hide other verdicts until a panelist files their own</span>
                <span className="block text-xs text-muted-foreground">
                  {cfg.blind_scorecards
                    ? "An interviewer sees the panel's other scorecards only after filing theirs, so four independent reads stay four reads."
                    : "Everyone sees the panel's scorecards as soon as they open the form - which is how the second interviewer ends up scoring the first one's opinion."}
                </span>
              </span>
            </label>
          </TabsContent>
        </Tabs>

        <Button onClick={save} loading={saving} disabled={!ready}>Save</Button>
      </CardContent>
    </Card>
  );
}

// What moving a card actually sets off, read from the org's OWN rules rather than described from the seeds: a
// pipeline that runs itself is only trustworthy if you can see what it will do. Each stage lists the enabled
// rules that fire on it, and every row opens that rule in the Workflows builder - which is where it is changed
// or switched off. A stage with nothing on it says so, because that is the useful thing to know.
function StageAutomationPreview({ stages }: { stages: AtsStage[] }) {
  const { rows: automations, state } = useCollection<Automation>("automations");
  // A rule belongs to a stage when it triggers on a stage change AND its condition names that stage (by key) or
  // its kind. Conditions are predicate trees, so this walks for a comparison rather than assuming a shape.
  const namesStage = (cond: unknown, stage: AtsStage): boolean => {
    if (!cond || typeof cond !== "object") return false;
    const c = cond as { field?: string; value?: unknown; all?: unknown[]; any?: unknown[]; not?: unknown };
    if (Array.isArray(c.all) || Array.isArray(c.any)) return [...(c.all ?? []), ...(c.any ?? [])].some((x) => namesStage(x, stage));
    if (c.not) return namesStage(c.not, stage);
    if (c.field === "stage") return c.value === stage.key;
    if (c.field === "stageKind") return c.value === stage.kind;
    return false;
  };
  const byStage = useMemo(() => {
    const live = automations.filter((a) => a.enabled !== false && !a.disabled);
    return stages.map((s) => ({
      stage: s,
      rules: live.filter((a) => a.trigger_type === "application.stageChanged" && namesStage(a.condition, s)),
    }));
  }, [automations, stages]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">What happens at each stage</p>
        <Button variant="ghost" size="sm" className="h-7" onClick={() => navigate("workflows")}>Edit in Workflows</Button>
      </div>
      {state === "loading" ? (
        <p className="text-xs text-muted-foreground">Reading your rules…</p>
      ) : (
        <ul className="space-y-1.5">
          {byStage.map(({ stage, rules }) => (
            <li key={stage.key} className="text-xs">
              <span className="font-medium">{stage.label}</span>
              {rules.length === 0 ? (
                <span className="text-muted-foreground"> - moving a card here only moves the card.</span>
              ) : (
                <ul className="ml-3 mt-0.5 space-y-0.5">
                  {rules.map((r) => (
                    <li key={r.path}>
                      <button type="button" className="text-left text-primary hover:underline" onClick={() => navigate(`workflows/${idOf(r.path)}`)} title={r.description ?? undefined}>
                        {r.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AttendanceTab({ toast }: { toast: Toast }) {
  const [cfg, setCfg] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getSetting<Partial<AttendanceSchedule>>("attendance")
      .then((s) => { if (s.value && Object.keys(s.value).length) setCfg({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  const toggleDay = (d: number) =>
    setCfg((c) => ({ ...c, work_days: c.work_days.includes(d) ? c.work_days.filter((x) => x !== d) : [...c.work_days, d].sort((a, b) => a - b) }));
  const graceRows = cfg.grace_exceptions ?? [];
  const graceKeys = useRowKeys(graceRows);
  const [saving, setSaving] = useState(false);
  const { markSaved } = useUnsaved(cfg, ready, save);
  async function save() {
    setSaving(true);
    try {
      await saveSetting("attendance", { value: cfg });
      // The SPA's idea of "today" is this key (lib/orgDay), memoised at bootstrap and never re-read. The
      // server adopts the new zone on the very next request, so without this line the tab that just changed
      // it - and every date input on it - carries on in the old one until a full page reload. The value is
      // right here, so no read is needed; the clock provider picks the rest of the blob up from the
      // invalidation `saveSetting` has already published.
      setOrgTimezone(cfg.timezone);
      markSaved();
      toast({ title: "Attendance schedule saved" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally { setSaving(false); }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction collection="settings" objectPath="settings/attendance" label="Attendance schedule"><span>Attendance schedule</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="max-w-xl space-y-4">
        <Tabs defaultValue="schedule">
          <TabsList variant="segmented">
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="pay">Pay & proration</TabsTrigger>
          </TabsList>

          <TabsContent value="schedule" className="space-y-4">
            <p className="text-sm text-muted-foreground">Used to flag late arrivals, early departures and absent days. Punch times are recorded as exact instants; the shift below is wall-clock in this timezone.</p>
            <Field label="Timezone" hint="The org's calendar day. Everything that turns on \u201ctoday\u201d - the LOP window, leave back-dating, the nightly tick - is read in this zone.">
              <Combobox
                className="w-full sm:w-80"
                value={cfg.timezone}
                onValueChange={(v) => setCfg((c) => ({ ...c, timezone: v }))}
                options={timezoneOptions(cfg.timezone)}
                placeholder="Select a timezone\u2026"
                searchPlaceholder="Search zones\u2026"
                emptyText="No zone matches."
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Shift start"><Input type="time" value={cfg.shift_start} onChange={(e) => setCfg((c) => ({ ...c, shift_start: e.target.value }))} /></Field>
              <Field label="Shift end"><Input type="time" value={cfg.shift_end} onChange={(e) => setCfg((c) => ({ ...c, shift_end: e.target.value }))} /></Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Grace (minutes)" hint="Lateness/early allowance."><Input type="number" min={0} value={cfg.grace_minutes} onChange={(e) => setCfg((c) => ({ ...c, grace_minutes: Number(e.target.value) }))} /></Field>
              <Field label="Full day (minutes)" hint="Worked-minutes at/above this is a full day."><Input type="number" min={0} value={cfg.full_day_minutes} onChange={(e) => setCfg((c) => ({ ...c, full_day_minutes: Number(e.target.value) }))} /></Field>
              <Field label="Half day (minutes)" hint="Minimum worked-minutes to earn a half day. Below this the day doesn't count."><Input type="number" min={0} value={cfg.half_day_minutes} onChange={(e) => setCfg((c) => ({ ...c, half_day_minutes: Number(e.target.value) }))} /></Field>
            </div>
            <Field label="Working days">
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((d, i) => (
                  <label key={d} className="flex items-center gap-1.5 text-sm">
                    <Checkbox checked={cfg.work_days.includes(i)} onCheckedChange={() => toggleDay(i)} /> {d}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Week starts on" hint="First column of every month grid (attendance, leave calendar).">
              <Select value={String(cfg.week_start ?? 0)} onValueChange={(v) => setCfg((c) => ({ ...c, week_start: Number(v) }))}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Grace exceptions" hint="On a listed date lateness/early departure is forgiven for everyone (bad weather, transit strike). Leave extra minutes blank to waive entirely, or add minutes on top of the daily grace.">
              <div className="space-y-2">
                {graceRows.map((ex, idx) => (
                  <div key={graceKeys[idx]} className="flex flex-wrap items-center gap-2">
                    <Input type="date" className="w-40" value={ex.date} onChange={(e) => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).map((x, i) => i === idx ? { ...x, date: e.target.value } : x) }))} />
                    <Input className="flex-1 min-w-[10rem]" placeholder="Reason (optional)" value={ex.reason ?? ""} onChange={(e) => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).map((x, i) => i === idx ? { ...x, reason: e.target.value } : x) }))} />
                    <Input type="number" min={0} className="w-32" placeholder="Waive all" value={ex.extra_grace_minutes ?? ""} onChange={(e) => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).map((x, i) => i === idx ? { ...x, extra_grace_minutes: e.target.value === "" ? undefined : Number(e.target.value) } : x) }))} />
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove this exception" onClick={() => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).filter((_, i) => i !== idx) }))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setCfg((c) => ({ ...c, grace_exceptions: [...(c.grace_exceptions ?? []), { date: "" }] }))}><Plus className="h-4 w-4" /> Add date</Button>
              </div>
            </Field>

            {/* Display-only: whether the Attendance page shows an employee how far through a full day they are.
                Some workplaces want the readout; others read the same bar as a clock-watching target. */}
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">What employees see on the clock card</p>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={cfg.show_day_progress !== false} onCheckedChange={(v) => setCfg((c) => ({ ...c, show_day_progress: !!v }))} />
                <span>
                  Progress toward a full day
                  <span className="block text-xs text-muted-foreground">The bar from 0 to the full-day minutes, the break summary, and the "no shift expected" note on holidays and days off. Punch times, today's total and the history are unaffected.</span>
                </span>
              </label>
              <label className={cn("flex items-start gap-2 text-sm", cfg.show_day_progress === false && "opacity-50")}>
                <Checkbox className="mt-0.5" disabled={cfg.show_day_progress === false} checked={cfg.show_finish_projection !== false} onCheckedChange={(v) => setCfg((c) => ({ ...c, show_finish_projection: !!v }))} />
                <span>
                  Projected finish time
                  <span className="block text-xs text-muted-foreground">The "Full day at ~6:12 PM" / "2h to a full day" line on that bar.</span>
                </span>
              </label>
            </div>
          </TabsContent>

          <TabsContent value="pay" className="space-y-4">
            <div className="rounded-lg border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={!!cfg.flexible_hours} onCheckedChange={(v) => setCfg((c) => ({ ...c, flexible_hours: !!v }))} />
                Flexible hours
              </label>
              <p className="mt-1 text-xs text-muted-foreground">Judge each day by minutes worked, not clock time. Someone who arrives late but still completes a full day's minutes counts as a full day (no late / early-departure flags). The shift start/end and grace on the Schedule tab are then used only for reference.</p>
            </div>

            <div className="rounded-lg border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={!!cfg.lop_enabled} onCheckedChange={(v) => setCfg((c) => ({ ...c, lop_enabled: !!v }))} />
                Deduct loss of pay for unexcused absences
              </label>
              <p className="mt-1 text-xs text-muted-foreground">When a payroll run is built, each unexcused absent working day (no punch, not on approved leave or holiday) is deducted from net pay.</p>
              {cfg.lop_enabled && (
                <FieldRow className="mt-3">
                  <Field label="Wage docked" hint="Which monthly wage an absent day comes out of.">
                    <Select value={cfg.lop_wage_basis ?? "gross"} onValueChange={(v) => setCfg((c) => ({ ...c, lop_wage_basis: v as "gross" | "basic" }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gross">Monthly gross (basic + allowances)</SelectItem>
                        <SelectItem value="basic">Basic only</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Per-day rate basis" hint="Divisor for that monthly wage.">
                    <Select value={cfg.lop_basis ?? "working_days"} onValueChange={(v) => setCfg((c) => ({ ...c, lop_basis: v as "working_days" | "days_30" }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="working_days">Working days in the period</SelectItem>
                        <SelectItem value="days_30">Fixed 30 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldRow>
              )}
              {cfg.lop_enabled && (cfg.lop_wage_basis ?? "gross") === "basic" && (
                <p className="mt-2 text-xs text-muted-foreground">An absent day then costs only the basic slice of the day's pay - the allowances stacked on it keep paying. Pick this only where those allowances are contractually unconditional.</p>
              )}
            </div>

            <div className="rounded-lg border p-3 sm:max-w-xs">
              <Field label="Partial-month proration basis" hint="How a mid-period joiner's or leaver's regular earnings are prorated for the days they were employed.">
                <Select value={cfg.proration_basis ?? "calendar_days"} onValueChange={(v) => setCfg((c) => ({ ...c, proration_basis: v as "calendar_days" | "working_days" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="calendar_days">Calendar days in the period</SelectItem>
                    <SelectItem value="working_days">Scheduled working days</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </TabsContent>
        </Tabs>
        <Button onClick={save} loading={saving} disabled={!ready}>{!saving && <Save className="h-4 w-4" />} Save schedule</Button>
      </CardContent>
    </Card>
  );
}

// Reimbursements config: org-wide payout mode (settings/reimbursements) + the categories collection below.
function ReimbursementsPanel({ toast, openId }: { toast: Toast; openId?: string }) {
  const [mode, setMode] = useState<"payroll" | "separate">("payroll");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSetting<{ payout_mode?: string }>("reimbursements")
      .then((s) => { if (s.value?.payout_mode === "separate") setMode("separate"); })
      .catch(() => {});
  }, []);

  async function save(next: "payroll" | "separate") {
    const before = mode;
    setMode(next);
    setSaving(true);
    try {
      await saveSetting("reimbursements", { value: { payout_mode: next } });
      toast({ title: "Payout mode saved", variant: "success" });
    } catch (e) {
      // PUT BACK on failure. This panel auto-saves on click and has no `useUnsaved` marker, so a failed save
      // used to leave the switch - and the paragraph under it - describing a mode the server rejected: the page
      // read "Approved claims are paid out-of-band" while payroll was still quietly adding claims to the next
      // run, until a reload silently flipped it back.
      setMode(before);
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  // Payout mode + the claim categories, split across tabs.
  return (
    <Tabs defaultValue="payout">
      <TabsList variant="segmented">
        <TabsTrigger value="payout">Payout</TabsTrigger>
        <TabsTrigger value="categories">Categories</TabsTrigger>
      </TabsList>

      <TabsContent value="payout">
        <Card>
          <CardContent className="space-y-3 pt-4 sm:pt-6">
            <p className="text-sm text-muted-foreground">How approved reimbursement claims are paid out.</p>
            <div className="flex items-center gap-2">
              <Button variant={mode === "payroll" ? "default" : "outline"} onClick={() => save("payroll")} disabled={saving}>Through payroll</Button>
              <Button variant={mode === "separate" ? "default" : "outline"} onClick={() => save("separate")} disabled={saving}>Separate</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {mode === "payroll"
                ? "Approved claims are added to the next payroll run as a non-taxable line and marked paid automatically."
                : "Approved claims are paid out-of-band; mark them paid from the Reimbursements page."}
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="categories">
        <ReimbursementCategories embedded openId={openId} />
      </TabsContent>
    </Tabs>
  );
}

// Operational-expenses config (settings/expenses blob) + the expense categories collection below. Controls the
// auto-approve threshold, the state recurring occurrences are generated in, and the budget-alert thresholds.
function ExpensesPanel({ toast, openId }: { toast: Toast; openId?: string }) {
  const [autoApprove, setAutoApprove] = useState("");
  const [recurringState, setRecurringState] = useState<"SUBMITTED" | "DRAFT">("SUBMITTED");
  const [thresholds, setThresholds] = useState("80, 100");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSetting<{ auto_approve_threshold?: number; recurring_default_state?: string; budget_alert_thresholds?: number[] }>("expenses")
      .then((s) => {
        const v = s.value ?? {};
        if (typeof v.auto_approve_threshold === "number" && v.auto_approve_threshold > 0) setAutoApprove(String(v.auto_approve_threshold));
        if (v.recurring_default_state === "DRAFT") setRecurringState("DRAFT");
        if (Array.isArray(v.budget_alert_thresholds) && v.budget_alert_thresholds.length) setThresholds(v.budget_alert_thresholds.join(", "));
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ autoApprove, recurringState, thresholds }, ready, save);
  async function save() {
    setSaving(true);
    try {
      const parsedThresholds = thresholds.split(",").map((t) => Number(t.trim())).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      await saveSetting("expenses", {
        value: {
          auto_approve_threshold: Number(autoApprove) > 0 ? Number(autoApprove) : 0,
          recurring_default_state: recurringState,
          budget_alert_thresholds: parsedThresholds.length ? parsedThresholds : [80, 100],
        },
      });
      markSaved();
      toast({ title: "Expense settings saved", variant: "success" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Tabs defaultValue="rules">
      <TabsList variant="segmented">
        <TabsTrigger value="rules">Rules</TabsTrigger>
        <TabsTrigger value="categories">Categories</TabsTrigger>
      </TabsList>

      <TabsContent value="rules">
        <Card>
          <CardContent className="space-y-4 pt-4 sm:pt-6">
            <Field label="Auto-approve threshold" hint="Expenses at or below this amount skip approval on submit. 0 (blank) disables auto-approval.">
              <Input type="number" min={0} step="1" value={autoApprove} onChange={(e) => setAutoApprove(e.target.value)} placeholder="e.g. 5000" className="max-w-48" />
            </Field>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Recurring expenses are generated as</p>
              <div className="flex items-center gap-2">
                <Button variant={recurringState === "SUBMITTED" ? "default" : "outline"} onClick={() => setRecurringState("SUBMITTED")} disabled={saving}>Submitted</Button>
                <Button variant={recurringState === "DRAFT" ? "default" : "outline"} onClick={() => setRecurringState("DRAFT")} disabled={saving}>Draft</Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {recurringState === "SUBMITTED" ? "New occurrences go straight into the approval queue." : "New occurrences are created as drafts for review before submission."}
              </p>
            </div>
            <Field label="Budget alert thresholds (%)" hint="Comma-separated. An alert fires once when a budget's spend crosses each level.">
              <Input value={thresholds} onChange={(e) => setThresholds(e.target.value)} placeholder="80, 100" className="max-w-48" />
            </Field>
            <div>
              <Button onClick={save} loading={saving}>Save</Button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="categories">
        <ExpenseCategories embedded openId={openId} />
      </TabsContent>
    </Tabs>
  );
}

// Support ticket categories + their default auto-assignee, stored in the `ticket-categories` settings blob.
// A new ticket filed under a category is auto-assigned to that category's employee; the assignee can still be
// changed per-ticket afterwards. Both the category list and each category's assignee are edited here.
function TicketsTab({ toast }: { toast: Toast }) {
  const [cats, setCats] = useState<TicketCategory[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });

  useEffect(() => {
    getSetting<{ categories?: TicketCategory[] }>("ticket-categories")
      .then((s) => setCats(s.value?.categories ?? []))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const update = (i: number, patch: Partial<TicketCategory>) => setCats((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () => setCats((cs) => [...cs, { key: "", name: "", assignee: null, members: [], department: null }]);
  const remove = (i: number) => setCats((cs) => cs.filter((_, j) => j !== i));
  const catKeys = useRowKeys(cats);
  const empName = (ref: string) => { const e = employees.find((x) => idOf(x.path) === idOf(ref)); return e ? `${e.first_name} ${e.last_name}` : idOf(ref); };
  const addMember = (i: number, ref: string) => setCats((cs) => cs.map((c, j) => (j === i && !(c.members ?? []).includes(ref) ? { ...c, members: [...(c.members ?? []), ref] } : c)));
  const removeMember = (i: number, ref: string) => setCats((cs) => cs.map((c, j) => (j === i ? { ...c, members: (c.members ?? []).filter((m) => m !== ref) } : c)));

  const { markSaved } = useUnsaved(cats, ready, save);
  async function save() {
    // Derive a stable key from the name for any new/blank rows; keep existing keys (tickets reference them).
    const used = new Set<string>();
    const out = cats
      .map((c) => ({ ...c, name: c.name.trim() }))
      .filter((c) => c.name)
      .map((c) => {
        let key = c.key || slug(c.name);
        while (used.has(key)) key = `${key}_`;
        used.add(key);
        return { key, name: c.name, assignee: c.assignee || null, members: c.members ?? [], department: c.department || null };
      });
    setSaving(true);
    try {
      await saveSetting("ticket-categories", { value: { categories: out } });
      setCats(out);
      markSaved();
      toast({ title: "Ticket categories saved", variant: "success" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction collection="settings" objectPath="settings/ticket-categories" label="Ticket categories"><span>Ticket categories</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Each category routes new tickets to a default assignee and servicing department (changeable per ticket). Members and the department's managers see every ticket in the category.</p>
        <div className="space-y-2">
          {cats.map((c, i) => (
            <div key={catKeys[i]} className="space-y-3 rounded-lg border p-3">
              {/* Three fields plus a remove button: side by side there is room for a name and two pickers on
                  a laptop, and about 100px each on a phone. Stacked below `sm`, with the remove button pulled
                  up onto the first row so it stays next to the name it removes. */}
              <div className="grid grid-cols-[1fr_auto] items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label="Category" className="min-w-0">
                  <Input value={c.name} placeholder="e.g. IT support" onChange={(e) => update(i, { name: e.target.value })} />
                </Field>
                <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove" className="sm:hidden"><Trash2 className="h-4 w-4" /></Button>
                <Field label="Auto-assign to" className="col-span-2 min-w-0 sm:col-span-1">
                  <Select value={c.assignee ?? "none"} onValueChange={(v) => update(i, { assignee: v === "none" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {employees.map((e) => <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Servicing department" className="col-span-2 min-w-0 sm:col-span-1">
                  <Select value={c.department ?? "none"} onValueChange={(v) => update(i, { department: v === "none" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove" className="hidden sm:inline-flex"><Trash2 className="h-4 w-4" /></Button>
              </div>
              <Field label="Members" hint="Can see every ticket in this category. The assignee is always included.">
                <div className="flex flex-wrap items-center gap-2">
                  {(c.members ?? []).map((m) => (
                    <Badge key={m} variant="secondary" className="gap-1">
                      {empName(m)}
                      <button type="button" onClick={() => removeMember(i, m)} aria-label={`Remove ${empName(m)}`}><X className="h-3 w-3" /></button>
                    </Badge>
                  ))}
                  <Select value="" onValueChange={(v) => addMember(i, v)}>
                    <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Add member…" /></SelectTrigger>
                    <SelectContent>
                      {employees.filter((e) => !(c.members ?? []).includes(`employees/${idOf(e.path)}`)).map((e) => (
                        <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </Field>
            </div>
          ))}
          {cats.length === 0 && <p className="text-sm text-muted-foreground">No categories yet. Add one to let employees raise tickets.</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={add}><Plus className="h-4 w-4" /> Add category</Button>
          <Button onClick={save} disabled={!ready || saving}><Save className="h-4 w-4" /> Save categories</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Predefined ticket checklists, now a first-class access-controlled collection (`ticket-checklists`). Each
// checklist is private-by-default: the access icon on its row controls who can see/use it in the ticket
// pickers. Admins create/edit/delete checklists here; an assignee copies one onto a ticket from its detail.
function TicketChecklistsTab({ toast }: { toast: Toast }) {
  const { rows, reload } = useCollection<TicketChecklist>("ticket-checklists");
  const [creating, setCreating] = useState(false);

  async function addNew() {
    setCreating(true);
    try {
      await create<TicketChecklist>("ticket-checklists", { display_name: "New checklist", items: [] });
      reload();
    } catch (e) {
      toast({ title: "Couldn't add checklist", description: (e as Error).message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle><AccessAction collection="ticket-checklists" label="Ticket checklists"><span>Checklists</span></AccessAction></CardTitle>
        <AccessAction collection="ticket-checklists" create label="New checklist">
          <Button variant="outline" onClick={addNew} disabled={creating}><Plus className="h-4 w-4" /> Add checklist</Button>
        </AccessAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">Predefined checklists an assignee can add to a ticket. Each checklist is private by default - use the access icon on a checklist to control who can see and use it.</p>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No checklists yet. Add one to reuse it across tickets.</p>}
        {rows.map((c) => <ChecklistRow key={c.path} checklist={c} reload={reload} toast={toast} />)}
      </CardContent>
    </Card>
  );
}

// One predefined checklist: name + items (one per line), with its own access-control icon (read grant =
// who can see/use it). Saves via PATCH only when edited; deletes the whole checklist.
function ChecklistRow({ checklist, reload, toast }: { checklist: TicketChecklist; reload: () => void; toast: Toast }) {
  const confirm = useConfirm();
  const original = (checklist.items ?? []).join("\n");
  const [name, setName] = useState(checklist.display_name);
  const [items, setItems] = useState(original);
  const [busy, setBusy] = useState(false);
  // What the server was last TOLD, which is what makes this row clean. The props only catch up when the list
  // refetch behind the save lands, and the row is not unsaved in the meantime - leaving it dirty until then
  // means pressing Save and immediately leaving the page is answered with "you have unsaved changes".
  const [saved, setSaved] = useState<{ name: string; items: string } | null>(null);
  const base = saved ?? { name: checklist.display_name, items: original };
  const dirty = name !== base.name || items !== base.items;
  useUnsavedTracker(dirty, () => (name.trim() ? save() : undefined), busy);

  async function save() {
    setBusy(true);
    try {
      // Normalized here as well as sent, so what the box shows afterwards is what was actually stored - a
      // trailing blank line would otherwise leave the row reading as edited the moment it was saved.
      const cleanName = name.trim();
      const cleanItems = items.split("\n").map((s) => s.trim()).filter(Boolean);
      await patch(checklist.path, { display_name: cleanName, items: cleanItems }, checklist.etag);
      setName(cleanName);
      setItems(cleanItems.join("\n"));
      setSaved({ name: cleanName, items: cleanItems.join("\n") });
      reload();
      toast({ title: "Checklist saved", variant: "success" });
    } catch (e) {
      // A record write with its own etag, not a settings blob - so this keeps the plain message rather than
      // the settings panels' conflict copy, which is about a snapshot that re-reads on the next press.
      toast({ title: "Couldn't save", description: describeError(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  async function del() {
    const ok = await confirm({
      title: "Delete this checklist?",
      description: `"${checklist.display_name}" stops being offered on new tickets in its category. Tickets that already carry it keep their copy.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await remove(checklist.path, checklist.etag);
      reload();
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-3 rounded-lg border p-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Input value={name} placeholder="e.g. Onboarding setup" onChange={(e) => setName(e.target.value)} />
          <AccessTarget target={{ collection: "ticket-checklists", objectPath: checklist.path, label: checklist.display_name, can: checklist.access?.can }} />
        </div>
        <Textarea rows={4} value={items} placeholder={"Create email account\nAssign laptop\nAdd to payroll"} onChange={(e) => setItems(e.target.value)} />
        {dirty && <Button size="sm" onClick={save} disabled={busy || !name.trim()}><Save className="h-4 w-4" /> Save</Button>}
      </div>
      <Button variant="ghost" size="icon" onClick={del} disabled={busy} aria-label="Delete checklist"><Trash2 className="h-4 w-4" /></Button>
    </div>
  );
}

// ---- Letterhead logos -------------------------------------------------------------------------------------
//
// The company's OTHER logos: an org with several legal entities or brands issues each one's letters on its own
// letterhead, so the catalogue is a list rather than the single organization logo above. A letter template
// points at one, and whoever generates a letter can override it for that one document.
//
// Unlike the identity form (one blob, one Save), each row here writes on its own - and the artwork goes to
// object storage, not into the settings blob that nearly every request reads.
// A letterhead is a PAGE, and a page is designed, not uploaded. So "Add letterhead" makes an empty one and
// opens the designer on it straight away: name it, design it, and add artwork only if the design wants any (a
// header rule and a typeface make a perfectly good letterhead on their own). The row has to exist first
// because the live preview renders through `letterheads/<id>:preview` and artwork lands in object storage
// under that id - so a designer closed without ever saving takes its brand-new row with it (`isNew` below),
// leaving no empty rows behind.
function LetterheadsPanel({ toast }: { toast: Toast }) {
  const { rows, reload } = useCollection<Letterhead>("letterheads");
  const [adding, setAdding] = useState(false);
  const [designing, setDesigning] = useState<{ row: Letterhead; isNew: boolean } | null>(null);
  // The open dialog follows the RELOADED row, not the one clicked: uploading artwork writes the row, so a
  // snapshot's etag would be stale by the time the design is saved. The clicked row stands in until the reload
  // that follows a create has landed.
  const designingRow = designing && (rows.find((r) => r.path === designing.row.path) ?? designing.row);

  async function add() {
    setAdding(true);
    try {
      const row = await create<Letterhead>("letterheads", { label: "New letterhead" });
      reload();
      setDesigning({ row, isNew: true });
    } catch (e) {
      toast({ title: "Couldn't add letterhead", description: (e as Error).message, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card className="mt-5">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="letterheads" label="Letterheads"><span>Letterheads</span></AccessAction>
        </CardTitle>
        <AccessAction collection="letterheads" create label="Add letterhead">
          <Button variant="outline" size="sm" onClick={add} disabled={adding}><Plus className="h-4 w-4" /> Add letterhead</Button>
        </AccessAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The stationery documents are issued on - one per legal entity or brand. Each is a page design: margins, typeface, palette, a header band,
          a footer band and a watermark, with optional artwork used either as the header mark or as full-page stationery. A letter template picks
          its own letterhead, whoever generates a letter can switch it for that document, and the section above sets one per document kind. Nothing
          here changes the app's own branding.
        </p>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No letterheads yet. Documents print on the stock page with the square mark above.</p>}
        {rows.map((l) => <LetterheadRow key={l.path} logo={l} reload={reload} toast={toast} onDesign={() => setDesigning({ row: l, isNew: false })} />)}
      </CardContent>
      {designing && designingRow && (
        <LetterheadDesigner
          // Keyed by row, so following a "Save as a copy" onto the copy remounts the editor against it rather
          // than leaving the previous letterhead's name and design in the fields.
          key={designingRow.path}
          open
          isNew={designing.isNew}
          logo={designingRow}
          reload={reload}
          onSwitchTo={(row) => setDesigning({ row, isNew: false })}
          onClose={() => setDesigning(null)}
        />
      )}
    </Card>
  );
}


// One letterhead in the list: what it looks like, what it is called, and the way into the designer - which is
// where the name, the page and the artwork are all edited. The row itself edits nothing, so there is one place
// to change a letterhead rather than three.
//
// The thumbnail is a second fetch (the artwork lives in object storage), so it loads per row, here, where
// somebody is actually looking at artwork - the generate picker lists names only.
function LetterheadRow({ logo, reload, toast, onDesign }: { logo: Letterhead; reload: () => void; toast: Toast; onDesign: () => void }) {
  const confirm = useConfirm();
  const path = logo.path!; // always present on a served row (readOnly, so the shared wire type has it optional)
  const [busy, setBusy] = useState(false);
  const [art, setArt] = useState<string | null>(null);

  // The list shows ONE image per row - whichever the page leads with (its stationery, else its mark), since a
  // thumbnail of four is a thumbnail of none. Images are held per version; the row previews the SCREEN
  // version, leading with its stationery if it has any, since that is what the page mostly looks like.
  //
  // A DATA url, not an object URL: this re-fetches whenever the row changes (every upload moves update_time),
  // and an object URL's cleanup revokes the one the <img> is still showing, which blanks the thumbnail.
  const assets = (logo.assets ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const screenSlots = Object.keys(assets.screen ?? {});
  const printSlots = Object.keys(assets.print ?? {});
  const thumbSlot = screenSlots.includes("stationery") ? "stationery" : screenSlots[0];
  useEffect(() => {
    if (!thumbSlot) { setArt(null); return; }
    let dropped = false;
    void dataUrl(path, { verb: "image", params: { slot: thumbSlot, variant: "screen" } })
      .then((src) => { if (!dropped) setArt(src); })
      .catch(() => { if (!dropped) setArt(null); }); // no access to the artwork, or it's gone - the row still names it
    return () => { dropped = true; };
  }, [path, thumbSlot, logo.update_time]);

  async function del() {
    const ok = await confirm({
      title: "Remove this letterhead?",
      description: `Anything set to "${logo.label}" falls back to the stock page with the organization logo. Documents already generated keep the page they were rendered on.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await remove(path, logo.etag);
      reload();
    } catch (e) {
      toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
        {art ? <img src={art} alt="" className="h-full w-full object-contain p-2" /> : <Building className="h-6 w-6 text-muted-foreground" />}
      </div>
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{logo.label}</p>
          <p className="text-xs text-muted-foreground">
            {[
              logo.design ? "Custom page" : "Stock page",
              `${screenSlots.length || "no"} screen image${screenSlots.length === 1 ? "" : "s"}`,
              logo.print_design || printSlots.length ? `own print version (${printSlots.length || "no"} image${printSlots.length === 1 ? "" : "s"})` : null,
            ].filter(Boolean).join(" · ")}
          </p>
        </div>
        <AccessTarget target={{ collection: "letterheads", objectPath: path, label: logo.label, can: logo.access?.can }} />
      </div>
      <div className="flex items-center gap-2">
        <AccessAction collection="letterheads" verb="preview" objectPath={path} can={logo.access?.can} label="Design the page">
          <Button variant="outline" size="sm" onClick={onDesign} disabled={busy}><Palette className="h-4 w-4" /> Design</Button>
        </AccessAction>
        <Button variant="ghost" size="icon" onClick={del} disabled={busy} aria-label="Remove letterhead"><Trash2 className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

// Organization identity (name + logo) - a single settings/organization row; the logo is a small data URL.
// Saving refreshes the app-wide org context so the sidebar brand updates immediately.
// The organization blob (settings/organization) backs three panels: identity, banks & currency and letter
// defaults. Each panel loads the full blob, edits its slice, and saves slice-merged-into-blob so the other
// panels' fields survive (read-modify-write; single-admin last-write-wins is fine here).
function useOrgBlob(toast: Toast) {
  const { reload } = useOrg();
  const [blob, setBlob] = useState<Partial<OrgSettings> | null>(null);
  // The version THIS blob was read at, carried to the save. The read happens once at mount and the save
  // rebuilds the whole blob from it, so the write has to be checked against the version the value came from -
  // a version looked up at write time can be a sibling tab's newer one, which turns "your copy is stale" into
  // an accepted write that silently reverts their slice (see saveSetting).
  const version = useRef<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    getSetting<Partial<OrgSettings>>("organization")
      .then((s) => { version.current = s.version; setBlob(s.value ?? {}); })
      .catch(() => setBlob({}));
  }, []);
  // Returns whether the save landed, so callers can clear their unsaved-changes baseline only on success.
  async function save(slice: Record<string, unknown>, savedTitle: string): Promise<boolean> {
    setSaving(true);
    try {
      const value = { ...(blob ?? {}), ...slice };
      await saveSetting("organization", { value }, version.current);
      // The row this tab now holds is the one it just wrote, so re-read the version it landed at: without it a
      // second save from the same open panel would carry the pre-save version and take a 409 it has not earned.
      version.current = (await getSetting<Partial<OrgSettings>>("organization")).version;
      setBlob(value as Partial<OrgSettings>);
      reload();
      toast({ title: savedTitle, variant: "success" });
      return true;
    } catch (e) {
      toast(saveSettingError(e));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { blob, save, saving };
}

// Org-wide config for the top-bar "+" (quick create) menu. The menu is a list of custom named sections, each
// holding an ordered list of enabled actions; sections and membership are fully editable. Stored in the org
// blob as quick_actions.groups. give-kudos is excluded (its own top-bar button). Per-user capability gating
// still applies at render, so a person only sees the enabled actions they can actually perform. Any action not
// placed in a section is "Not in the menu" (disabled).
function QuickActionsTab({ toast }: { toast: Toast }) {
  const { blob, save, saving } = useOrgBlob(toast);
  const metaOf = (id: string) => CONFIGURABLE_QUICK_ACTIONS.find((a) => a.id === id);
  const [groups, setGroups] = useState<QuickMenuGroup[]>([]);
  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
    // Drop unknown ids up front so the editor only ever shows real actions.
    const known = new Set(CONFIGURABLE_QUICK_ACTIONS.map((a) => a.id));
    setGroups(
      normalizeQuickMenu(blob.quick_actions).groups.map((g) => ({ ...g, items: g.items.filter((id) => known.has(id)) })),
    );
    setReady(true); // batched with setGroups, so the unsaved baseline captures the hydrated value
  }, [blob]);

  const placed = new Set(groups.flatMap((g) => g.items));
  const unplaced = CONFIGURABLE_QUICK_ACTIONS.filter((a) => !placed.has(a.id));

  const newGroupId = () => `g${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const addGroup = () => setGroups((gs) => [...gs, { id: newGroupId(), label: "New section", items: [] }]);
  const renameGroup = (gid: string, label: string) => setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, label } : g)));
  const deleteGroup = (gid: string) => setGroups((gs) => gs.filter((g) => g.id !== gid)); // items fall back to "Not in the menu"
  const moveGroup = (i: number, dir: -1 | 1) =>
    setGroups((gs) => { const j = i + dir; if (j < 0 || j >= gs.length) return gs; const n = [...gs]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const moveItem = (gid: string, i: number, dir: -1 | 1) =>
    setGroups((gs) => gs.map((g) => {
      if (g.id !== gid) return g;
      const j = i + dir; if (j < 0 || j >= g.items.length) return g;
      const items = [...g.items]; [items[i], items[j]] = [items[j], items[i]]; return { ...g, items };
    }));
  // Move an action to a target section (or "off" to remove it from the menu). Always strip it from every
  // section first so it lives in exactly one place.
  const assign = (id: string, targetGid: string) =>
    setGroups((gs) => gs.map((g) => {
      const stripped = g.items.filter((x) => x !== id);
      return g.id === targetGid ? { ...g, items: [...stripped, id] } : { ...g, items: stripped };
    }));

  const { markSaved } = useUnsaved(groups, ready, onSave);
  async function onSave() {
    const cleaned = groups.map((g) => ({ id: g.id, label: g.label.trim() || "Untitled", items: g.items }));
    if (await save({ quick_actions: { groups: cleaned, order: undefined } }, "Quick create menu saved")) markSaved();
  }

  if (!blob) return panelLoading;

  const groupOptions = groups.map((g) => ({ value: g.id, label: g.label.trim() || "Untitled" }));

  const actionRow = (id: string, opts: { gid?: string; index?: number; count?: number }) => {
    const a = metaOf(id);
    if (!a) return null;
    const Icon = a.icon;
    const inGroup = !!opts.gid;
    return (
      <div key={id} className="flex items-center gap-2 rounded-md border px-3 py-2 sm:gap-3">
        <Icon className={cn("h-4 w-4 shrink-0", inGroup ? "text-foreground" : "text-muted-foreground")} />
        <span className={cn("min-w-0 flex-1 truncate text-sm", !inGroup && "text-muted-foreground")}>{a.label}</span>
        {/* Narrower on a phone: this control plus the label plus the two reorder buttons is the whole
            328px content column at w-40, which leaves the action's name no room at all. */}
        <Select value={opts.gid ?? "off"} onValueChange={(v) => assign(id, v)}>
          <SelectTrigger className="h-8 w-32 text-xs sm:w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Not in the menu</SelectItem>
            {groupOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {inGroup && (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={opts.index === 0} onClick={() => moveItem(opts.gid!, opts.index!, -1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={opts.index === (opts.count ?? 0) - 1} onClick={() => moveItem(opts.gid!, opts.index!, 1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Build the sections of the top-bar + (New) menu: rename them, reorder them, and place actions where you
        want. Everyone shares this menu, but a person only sees actions they have access to.
      </p>

      {groups.map((g, gi) => (
        <Card key={g.id}>
          <CardContent className="space-y-2 pt-4">
            <div className="mb-1 flex items-center gap-2">
              <Input value={g.label} onChange={(e) => renameGroup(g.id, e.target.value)} placeholder="Section name" className="h-8 max-w-xs font-medium" />
              <div className="ml-auto flex items-center gap-0.5">
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={gi === 0} onClick={() => moveGroup(gi, -1)} aria-label="Move section up"><ArrowUp className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={gi === groups.length - 1} onClick={() => moveGroup(gi, 1)} aria-label="Move section down"><ArrowDown className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteGroup(g.id)} aria-label="Delete section"><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            {g.items.length === 0
              ? <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">No actions yet - add one from "Not in the menu" below.</p>
              : <div className="space-y-1.5">{g.items.map((id, i) => actionRow(id, { gid: g.id, index: i, count: g.items.length }))}</div>}
          </CardContent>
        </Card>
      ))}

      <Button variant="outline" size="sm" onClick={addGroup}><Plus className="h-4 w-4" /> Add section</Button>

      {unplaced.length > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Not in the menu</p>
            <div className="space-y-1.5">{unplaced.map((a) => actionRow(a.id, {}))}</div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={onSave} loading={saving}><Save className="h-4 w-4" /> Save menu</Button>
      </div>
    </div>
  );
}

// One brand-image slot: preview swatch, choose/replace, remove. Every image here is stored as a data URL in the
// settings/organization blob, so the size caps are what keeps that blob small. `dark` previews the slot on a dark
// swatch (light-on-dark artwork is invisible on `bg-muted`, whichever theme the admin is using); `wide` swaps the
// square tile for a full-width strip, matching how a wordmark actually renders in the sidebar.
function BrandImageField({
  value,
  onChange,
  choose,
  hint,
  accept = "image/*",
  maxBytes,
  dark,
  wide,
  icon: Icon,
  toast,
}: {
  value?: string;
  onChange: (v: string | undefined) => void;
  choose: string;
  hint: string;
  accept?: string;
  maxBytes: number;
  dark?: boolean;
  wide?: boolean;
  icon: typeof Building;
  toast: Toast;
}) {
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // so re-picking the same file after a Remove still fires a change
    if (!f) return;
    if (f.size > maxBytes) {
      toast({ variant: "destructive", title: "Image too large", description: `Use a file under ${Math.round(maxBytes / 1024)} KB.` });
      return;
    }
    const r = new FileReader();
    r.onload = () => onChange(r.result as string);
    r.readAsDataURL(f);
  }
  return (
    // A 160px preview beside "Choose logo" and Remove is wider than a phone's content column, so the pair
    // wraps and the controls take a line under the preview.
    <div className="flex flex-wrap items-center gap-4">
      <div
        className={cn(
          "flex h-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border",
          wide ? "w-40" : "w-16",
          dark ? "bg-slate-900" : "bg-muted",
        )}
      >
        {value ? (
          <img src={value} alt="" className={cn("h-full w-full", wide ? "object-contain p-2" : "object-cover")} />
        ) : (
          <Icon className={cn("h-6 w-6", dark ? "text-slate-500" : "text-muted-foreground")} />
        )}
      </div>
      <div className="min-w-0 flex-1 basis-48 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
            {value ? "Replace" : choose}
            <input type="file" accept={accept} className="hidden" onChange={onFile} />
          </label>
          {value && (
            <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>
              <X className="h-4 w-4" /> Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

// Every generated PDF picks a letterhead the same way, and only the letter engine has a per-template and a
// per-document choice to make it with - the rest are org-wide, so they are chosen here. Keys match
// services/letterheads.ts DOCUMENT_KINDS; the server rejects any other key.
const DOCUMENT_LETTERHEADS = [
  { key: "letter", label: "Letters", hint: "Used by a letter type that doesn't name its own." },
  { key: "payslip", label: "Payslips", hint: "Applies from the next payslip generated." },
  { key: "form16", label: "Form 16", hint: "The annual TDS certificate." },
  { key: "offer", label: "Offer letters", hint: "Issued from a candidate's offer." },
  { key: "review", label: "Review summaries", hint: "The exported performance review PDF." },
] as const;

function OrgIdentityPanel({ toast }: { toast: Toast }) {
  const { blob, save, saving } = useOrgBlob(toast);
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [logo, setLogo] = useState<string | undefined>(undefined);
  const [logoDark, setLogoDark] = useState<string | undefined>(undefined); // optional dark-theme variant; blank = use `logo`
  const [wordmark, setWordmark] = useState<string | undefined>(undefined); // wide logo+name artwork; set = replaces the square mark AND the name text in the sidebar
  const [wordmarkDark, setWordmarkDark] = useState<string | undefined>(undefined);
  const [favicon, setFavicon] = useState<string | undefined>(undefined); // browser-tab icon (small data URL)
  const [logoText, setLogoText] = useState(""); // sidebar wordmark override (casing/spelling); blank = use name
  const [nameFont, setNameFont] = useState("default");
  const [nameWeight, setNameWeight] = useState("bold");
  const [nameSize, setNameSize] = useState("medium");
  const [address, setAddress] = useState("");
  const [incorporationDate, setIncorporationDate] = useState("");
  const [defaultDept, setDefaultDept] = useState("none"); // org-wide default department for cards + tickets
  const [primaryColor, setPrimaryColor] = useState("#1D4C91"); // brand accent (email header/buttons; hex)
  const [emailLogoUrl, setEmailLogoUrl] = useState(""); // public https logo for email headers (the app logo is a data URL, which email clients strip)
  const [docLogos, setDocLogos] = useState<Record<string, string>>({}); // document kind -> letterhead ref; absent = the square mark
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const letterheads = useLetterheads();

  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);
  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
    setReady(true); // batched with the hydration setters below, so the baseline captures the loaded values
    if (blob.name) setName(blob.name);
    if (blob.legal_name) setLegalName(blob.legal_name);
    if (blob.logo) setLogo(blob.logo);
    if (blob.logo_dark) setLogoDark(blob.logo_dark);
    if (blob.wordmark) setWordmark(blob.wordmark);
    if (blob.wordmark_dark) setWordmarkDark(blob.wordmark_dark);
    if (blob.favicon) setFavicon(blob.favicon);
    if (blob.logo_text) setLogoText(blob.logo_text);
    if (blob.name_font) setNameFont(blob.name_font);
    if (blob.name_weight) setNameWeight(blob.name_weight);
    if (blob.name_size) setNameSize(blob.name_size);
    if (blob.address) setAddress(blob.address);
    if (blob.incorporation_date) setIncorporationDate(blob.incorporation_date);
    if (blob.default_department) setDefaultDept(blob.default_department);
    if (blob.primary_color) setPrimaryColor(blob.primary_color);
    if (blob.email_logo_url) setEmailLogoUrl(blob.email_logo_url);
    if (blob.document_logos) setDocLogos(blob.document_logos);
  }, [blob]);

  const { markSaved } = useUnsaved(
    { name, legalName, logo, logoDark, wordmark, wordmarkDark, favicon, logoText, nameFont, nameWeight, nameSize, address, incorporationDate, defaultDept, primaryColor, emailLogoUrl, docLogos },
    ready,
    saveIdentity,
  );
  async function saveIdentity() {
    const ok = await save(
      { name: name.trim(), legal_name: legalName.trim() || null, logo: logo ?? null, logo_dark: logoDark ?? null, wordmark: wordmark ?? null, wordmark_dark: wordmarkDark ?? null, favicon: favicon ?? null, logo_text: logoText.trim() || null, name_font: nameFont, name_weight: nameWeight, name_size: nameSize, address: address.trim() || null, incorporation_date: incorporationDate || null, default_department: defaultDept === "none" ? null : defaultDept, primary_color: primaryColor || null, email_logo_url: emailLogoUrl.trim() || null, document_logos: docLogos },
      "Organization saved",
    );
    if (ok) markSaved();
  }

  return (
    <div>
      {/* Identity is one form split across tabs: artwork, then the name and its sidebar typography, then the
          company facts other modules read. All tabs share the single Save below - switching tabs keeps edits. */}
      <Tabs defaultValue="logos">
        <TabsList>
          <TabsTrigger value="logos"><ImageIcon className="h-4 w-4" /> Logos</TabsTrigger>
          <TabsTrigger value="letterheads"><Palette className="h-4 w-4" /> Letterheads</TabsTrigger>
          <TabsTrigger value="name"><Type className="h-4 w-4" /> Name</TabsTrigger>
          <TabsTrigger value="details"><Building className="h-4 w-4" /> Company details</TabsTrigger>
        </TabsList>
        <TabsContent value="logos">
          <Card>
            <CardContent className="space-y-6 pt-4 sm:pt-6">
              <div className="space-y-3">
                <p className="text-sm font-medium">Square mark</p>
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <BrandImageField
                    value={logo}
                    onChange={setLogo}
                    choose="Choose logo"
                    hint="Shown beside the name in the sidebar and in the collapsed rail. PNG, JPG or SVG, under 256 KB."
                    maxBytes={MAX_LOGO_BYTES}
                    icon={Building}
                    toast={toast}
                  />
                  <BrandImageField
                    value={logoDark}
                    onChange={setLogoDark}
                    choose="Choose dark logo"
                    hint="Optional. Used while the dark theme is on."
                    maxBytes={MAX_LOGO_BYTES}
                    dark
                    icon={Building}
                    toast={toast}
                  />
                </div>
              </div>
              <div className="space-y-3 border-t pt-4 sm:pt-6">
                <div>
                  <p className="text-sm font-medium">Wordmark</p>
                  <p className="text-xs text-muted-foreground">Wide artwork carrying the name. Set one and it spans the sidebar in place of the square mark and the name text; the collapsed rail keeps using the square mark.</p>
                </div>
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <BrandImageField
                    value={wordmark}
                    onChange={setWordmark}
                    choose="Choose wordmark"
                    hint="Optional. PNG, JPG or SVG, under 256 KB."
                    maxBytes={MAX_LOGO_BYTES}
                    wide
                    icon={Type}
                    toast={toast}
                  />
                  <BrandImageField
                    value={wordmarkDark}
                    onChange={setWordmarkDark}
                    choose="Choose dark wordmark"
                    hint="Optional. Used while the dark theme is on."
                    maxBytes={MAX_LOGO_BYTES}
                    dark
                    wide
                    icon={Type}
                    toast={toast}
                  />
                </div>
              </div>
              <div className="space-y-3 border-t pt-4 sm:pt-6">
                <p className="text-sm font-medium">Elsewhere</p>
                <BrandImageField
                  value={favicon}
                  onChange={setFavicon}
                  choose="Choose favicon"
                  hint="Browser-tab icon. PNG, SVG or ICO, under 64 KB."
                  accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/jpeg"
                  maxBytes={MAX_FAVICON_BYTES}
                  icon={Globe}
                  toast={toast}
                />
                <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                  <Field label="Brand colour" hint="Accent for email headers and buttons.">
                    <div className="flex items-center gap-2">
                      <input type="color" aria-label="Brand colour" value={/^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : "#1D4C91"} onChange={(e) => setPrimaryColor(e.target.value)} className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1" />
                      <Input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} placeholder="#1D4C91" className="font-mono" />
                    </div>
                  </Field>
                  <Field label="Email logo URL" hint="Public https image shown in email headers. The uploaded logos are data URLs, which email clients block, so email uses this URL instead; blank shows the name.">
                    <Input value={emailLogoUrl} onChange={(e) => setEmailLogoUrl(e.target.value)} placeholder="https://cdn.example.com/logo.png" />
                  </Field>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        {/* Letterheads are their own subject - a catalogue of pages, and which document kind prints on which -
            so they get a tab rather than a third section under the app's own branding marks. The assignment
            grid shares this panel's Save; the catalogue below it writes its own rows as they are edited. */}
        <TabsContent value="letterheads">
          <Card>
            <CardContent className="space-y-3 pt-4 sm:pt-6">
              <div>
                <p className="text-sm font-medium">Document letterheads</p>
                <p className="text-xs text-muted-foreground">
                  Which letterhead each generated PDF prints on. A letter type that names its own letterhead, and a single letter generated on
                  another, both still win over this.
                </p>
              </div>
              {letterheads.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing to choose between yet - add a letterhead below and these become pickers.</p>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {DOCUMENT_LETTERHEADS.map((k) => (
                    <Field key={k.key} label={k.label} hint={k.hint}>
                      <Select
                        value={letterheads.some((l) => l.path === docLogos[k.key]) ? docLogos[k.key]! : "__org"}
                        onValueChange={(v) => setDocLogos(({ [k.key]: _drop, ...rest }) => (v === "__org" ? rest : { ...rest, [k.key]: v }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__org">Square mark</SelectItem>
                          {letterheads.map((l) => <SelectItem key={l.path} value={l.path!}>{l.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </Field>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <LetterheadsPanel toast={toast} />
        </TabsContent>
        <TabsContent value="name">
          <Card>
            <CardContent className="space-y-6 pt-4 sm:pt-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Organization name" hint="Shown across the app and on payslips.">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Corp" />
                </Field>
                <Field label="Legal name" hint="Registered legal entity name. Leave blank to use the organization name.">
                  <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="e.g. Acme Technologies Private Limited" />
                </Field>
              </div>
              <Field label="Sidebar display name" hint="Sidebar logo only (casing/spelling). Blank uses the organization name.">
                <Input value={logoText} onChange={(e) => setLogoText(e.target.value)} placeholder={name || "e.g. acme"} className="sm:max-w-sm" />
              </Field>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-start">
                <Field label="Font">
                  <select className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm coarse:min-h-10" value={nameFont} onChange={(e) => setNameFont(e.target.value)}>
                    {NAME_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </Field>
                <Field label="Weight">
                  <select className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm coarse:min-h-10" value={nameWeight} onChange={(e) => setNameWeight(e.target.value)}>
                    {NAME_WEIGHTS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </Field>
                <Field label="Size">
                  <select className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm coarse:min-h-10" value={nameSize} onChange={(e) => setNameSize(e.target.value)}>
                    {NAME_SIZES.map((sz) => <option key={sz.value} value={sz.value}>{sz.label}</option>)}
                  </select>
                </Field>
                <Field label="Preview" hint="Styles the sidebar logo only.">
                  <div className="flex h-9 items-center rounded-md bg-sidebar px-3">
                    <span className="truncate text-foreground" style={{ fontFamily: orgNameFontStack(nameFont), fontWeight: orgNameWeight(nameWeight), fontSize: orgNameSizePx(nameSize) }}>{logoText.trim() || name || "Acme Corp"}</span>
                  </div>
                </Field>
              </div>
              {wordmark && (
                <p className="text-xs text-muted-foreground">
                  A wordmark is set, so the sidebar draws that artwork and none of this text. The display name stays the wordmark's alt text, and the organization name is still used everywhere else (payslips, letters, emails).
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="details">
          <Card>
            <CardContent className="space-y-6 pt-4 sm:pt-6">
              <Field label="Address" hint="Printed in the payslip header. One line per row.">
                <Textarea rows={3} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={"Street address\nArea or landmark\nCity, State PIN"} className="sm:max-w-md" />
              </Field>
              <Field label="Incorporation date" hint="Used to celebrate the company anniversary.">
                <Input type="date" className="w-44" value={incorporationDate} onChange={(e) => setIncorporationDate(e.target.value)} />
              </Field>
              <Field label="Default department" hint="New board tasks and support tickets default to this department when none is set.">
                <Select value={defaultDept} onValueChange={setDefaultDept}>
                  <SelectTrigger className="w-64"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <Button className="mt-4" onClick={saveIdentity} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save</Button>
    </div>
  );
}

function OrgBanksPanel({ toast }: { toast: Toast }) {
  const { blob, save, saving } = useOrgBlob(toast);
  const [currencies, setCurrencies] = useState("INR, USD, EUR, GBP, AED, SGD");
  const [defaultCurrency, setDefaultCurrency] = useState("INR");
  const [banks, setBanks] = useState("");
  // Per-currency display/payout precision (decimal places). Money is stored full precision; this only sets how
  // many places each currency is shown and paid in (INR = 0 -> whole rupees by default).
  const [decimals, setDecimals] = useState<Record<string, number>>({});

  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);
  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
    setReady(true); // batched with the hydration setters below
    if (Array.isArray(blob.currencies) && blob.currencies.length) setCurrencies(blob.currencies.join(", "));
    if (blob.default_currency) setDefaultCurrency(blob.default_currency);
    if (blob.currency_decimals) setDecimals(blob.currency_decimals);
    if (Array.isArray(blob.banks)) setBanks(blob.banks.join("\n"));
  }, [blob]);

  // Parsed, normalised allowed lists - the options for the currency / bank pickers across the app.
  const allowedList = Array.from(new Set(currencies.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)));
  const bankList = Array.from(new Set(banks.split(/[\n,]/).map((b) => b.trim()).filter(Boolean)));
  // Resolved decimals for a currency: explicit override, else the app default (currencyDecimals base table).
  const dpFor = (c: string) => decimals[c] ?? currencyDecimals(c, { currency_decimals: decimals } as OrgSettings);
  const setDp = (c: string, v: number) => setDecimals((d) => ({ ...d, [c]: Math.min(4, Math.max(0, Math.trunc(v) || 0)) }));

  const { markSaved } = useUnsaved({ currencies, defaultCurrency, banks, decimals }, ready, saveBanks);
  async function saveBanks() {
    const allowed = allowedList.length ? allowedList : ["INR"];
    const def = allowed.includes(defaultCurrency) ? defaultCurrency : allowed[0];
    // Persist a decimals entry for every allowed currency (resolved value), so the config is explicit.
    const currency_decimals = Object.fromEntries(allowed.map((c) => [c, dpFor(c)]));
    if (await save({ currencies: allowed, default_currency: def, currency_decimals, banks: bankList }, "Banks & currency saved")) markSaved();
  }

  return (
    <div>
      <Card>
        <CardContent className="pt-4 sm:pt-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-4">
              <Field label="Allowed currencies" hint="Comma-separated ISO codes.">
                <Input value={currencies} onChange={(e) => setCurrencies(e.target.value)} placeholder="INR, USD, EUR" />
              </Field>
              <Field label="Default currency" hint="Default selection, and used for untagged amounts.">
                <select
                  className="h-9 w-40 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm coarse:min-h-10"
                  value={allowedList.includes(defaultCurrency) ? defaultCurrency : (allowedList[0] ?? "")}
                  onChange={(e) => setDefaultCurrency(e.target.value)}
                >
                  {allowedList.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Decimal places" hint="How many decimals each currency is shown and paid in. 0 = whole units (e.g. INR in whole rupees, no paise). Amounts are stored at full precision; this rounds only for display and payout.">
                <div className="space-y-1.5">
                  {allowedList.map((c) => (
                    <div key={c} className="flex items-center gap-2">
                      <span className="w-12 text-sm tabular-nums text-muted-foreground">{c}</span>
                      <Input type="number" min={0} max={4} step={1} className="h-8 w-20" value={dpFor(c)} onChange={(e) => setDp(c, Number(e.target.value))} />
                      <span className="text-xs text-muted-foreground">e.g. {formatMoney(1234.5, c, dpFor(c))}</span>
                    </div>
                  ))}
                </div>
              </Field>
            </div>
            <Field label="Allowed banks" hint="One per line.">
              <Textarea rows={6} value={banks} onChange={(e) => setBanks(e.target.value)} placeholder={"Bank name\nAnother bank"} />
            </Field>
          </div>
        </CardContent>
      </Card>
      <Button className="mt-4" onClick={saveBanks} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save</Button>
    </div>
  );
}

// Letter defaults: the values HR letters need beyond the employee/comp record (signatory, contact,
// working pattern, offer validity). Persisted under organization.letter_defaults.
function OrgLetterDefaultsPanel({ toast }: { toast: Toast }) {
  const { blob, save, saving } = useOrgBlob(toast);
  const [letter, setLetter] = useState<Partial<Record<keyof LetterDefaults, string>>>({});
  const setLetterField = (k: keyof LetterDefaults, v: string) => setLetter((s) => ({ ...s, [k]: v }));
  // The authorized-signatory signature image (data URL) is the employer's e-signature on generated letters;
  // handled apart from the text fields (it's an image upload, not in the `letter` text map).
  const [signatorySig, setSignatorySig] = useState<string | undefined>(undefined);
  // Company stamp/seal image (data URL); like the signature, an image upload kept apart from the text map.
  const [companyStamp, setCompanyStamp] = useState<string | undefined>(undefined);

  const [ready, setReady] = useState(false);
  const hydrated = useRef(false);
  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
    setReady(true); // batched with the hydration setters below
    const ld = blob.letter_defaults;
    if (ld) {
      if (ld.signatory_signature) setSignatorySig(ld.signatory_signature);
      if (ld.company_stamp) setCompanyStamp(ld.company_stamp);
      setLetter(Object.fromEntries(Object.entries(ld).filter(([k, v]) => v != null && k !== "signatory_signature" && k !== "company_stamp").map(([k, v]) => [k, String(v)])));
    }
  }, [blob]);

  function onSignatoryFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_LOGO_BYTES) {
      toast({ variant: "destructive", title: "Signature too large", description: "Use an image under 256 KB." });
      return;
    }
    const r = new FileReader();
    r.onload = () => setSignatorySig(r.result as string);
    r.readAsDataURL(f);
  }

  function onStampFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_LOGO_BYTES) {
      toast({ variant: "destructive", title: "Stamp too large", description: "Use an image under 256 KB." });
      return;
    }
    const r = new FileReader();
    r.onload = () => setCompanyStamp(r.result as string);
    r.readAsDataURL(f);
  }

  const { markSaved } = useUnsaved({ letter, signatorySig, companyStamp }, ready, saveLetterDefaults);
  async function saveLetterDefaults() {
    // Drop blank fields so the stored block stays tidy; coerce validity to a number.
    const letterDefaults: LetterDefaults = {};
    for (const [k, v] of Object.entries(letter)) {
      if (k === "offer_validity_days") { const n = Number(v); if (Number.isFinite(n) && n > 0) letterDefaults.offer_validity_days = n; }
      else if (typeof v === "string" && v.trim()) (letterDefaults as Record<string, unknown>)[k] = v.trim();
    }
    if (signatorySig) letterDefaults.signatory_signature = signatorySig; // employer e-signature (omitted when cleared)
    if (companyStamp) letterDefaults.company_stamp = companyStamp; // company stamp/seal (omitted when cleared)
    if (await save({ letter_defaults: letterDefaults }, "Letter defaults saved")) markSaved();
  }

  return (
    <div>
      <Tabs defaultValue="signatory">
        <TabsList variant="segmented">
          <TabsTrigger value="signatory">Signatory</TabsTrigger>
          <TabsTrigger value="hr">HR contact</TabsTrigger>
          <TabsTrigger value="terms">Offer terms</TabsTrigger>
        </TabsList>

        <TabsContent value="signatory">
          <Card>
            <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 sm:pt-6">
              <Field label="Signatory name" hint="Signs generated letters.">
                <Input value={letter.signatory_name ?? ""} onChange={(e) => setLetterField("signatory_name", e.target.value)} placeholder="Full name of the signatory" />
              </Field>
              <Field label="Signatory title">
                <Input value={letter.signatory_title ?? ""} onChange={(e) => setLetterField("signatory_title", e.target.value)} placeholder="e.g. HR Manager" />
              </Field>
              <Field label="Signatory signature" hint="The employer's e-signature, stamped above the signatory name on generated letters.">
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-40 items-center justify-center overflow-hidden rounded-md border bg-white p-1 dark:bg-brand-neutral-100">
                    {signatorySig ? <img src={signatorySig} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted-foreground">No signature</span>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="cursor-pointer text-sm font-medium text-primary hover:underline">
                      {signatorySig ? "Replace" : "Upload"}
                      <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={onSignatoryFile} />
                    </label>
                    {signatorySig && <button type="button" className="text-left text-xs text-muted-foreground hover:text-destructive" onClick={() => setSignatorySig(undefined)}>Remove</button>}
                  </div>
                </div>
              </Field>
              <Field label="Company stamp" hint="Company seal/stamp, overlaid beside the signatory on generated letters. A transparent PNG works best.">
                <div className="flex items-center gap-3">
                  <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-white p-1 dark:bg-brand-neutral-100">
                    {companyStamp ? <img src={companyStamp} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted-foreground">No stamp</span>}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="cursor-pointer text-sm font-medium text-primary hover:underline">
                      {companyStamp ? "Replace" : "Upload"}
                      <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={onStampFile} />
                    </label>
                    {companyStamp && <button type="button" className="text-left text-xs text-muted-foreground hover:text-destructive" onClick={() => setCompanyStamp(undefined)}>Remove</button>}
                  </div>
                </div>
              </Field>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hr">
          <Card>
            <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 sm:pt-6">
              <Field label="HR contact name">
                <Input value={letter.hr_name ?? ""} onChange={(e) => setLetterField("hr_name", e.target.value)} placeholder="e.g. HR Department" />
              </Field>
              <Field label="HR contact email" hint="Falls back to the system sender if blank.">
                <Input value={letter.hr_email ?? ""} onChange={(e) => setLetterField("hr_email", e.target.value)} placeholder="hr@example.com" />
              </Field>
              <Field label="HR contact phone">
                <Input type="tel" inputMode="tel" value={letter.hr_phone ?? ""} onChange={(e) => setLetterField("hr_phone", e.target.value)} placeholder="Optional" />
              </Field>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="terms">
          <Card>
            <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 sm:pt-6">
              <Field label="Working hours" hint="Shown in the offer letter.">
                <Input value={letter.working_hours ?? ""} onChange={(e) => setLetterField("working_hours", e.target.value)} placeholder="e.g. 10:00 AM to 7:00 PM" />
              </Field>
              <Field label="Working days">
                <Input value={letter.working_days ?? ""} onChange={(e) => setLetterField("working_days", e.target.value)} placeholder="e.g. Monday to Friday" />
              </Field>
              <Field label="Work mode">
                <select
                  className="h-9 w-40 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm coarse:min-h-10"
                  value={letter.work_mode ?? ""}
                  onChange={(e) => setLetterField("work_mode", e.target.value)}
                >
                  <option value="">Not set</option>
                  <option value="on-site">On-site</option>
                  <option value="remote">Remote</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </Field>
              <Field label="Work location">
                <Input value={letter.work_location ?? ""} onChange={(e) => setLetterField("work_location", e.target.value)} placeholder="e.g. office city" />
              </Field>
              <Field label="Offer validity (days)" hint="Offer letters expire this many days after issue.">
                <Input type="number" min={0} value={letter.offer_validity_days ?? ""} onChange={(e) => setLetterField("offer_validity_days", e.target.value)} placeholder="e.g. 7" />
              </Field>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {/* One blob, one Save: it persists every tab, not just the visible one. */}
      <Button className="mt-4" onClick={saveLetterDefaults} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save</Button>
    </div>
  );
}

// Dashboard config (settings/dashboard): which KPI cards and timeline markers each ROLE sees. Per item, the
// selected roles restrict visibility; no roles selected = everyone. Default (unset) shows everything. Keys
// match the dashboard's KPI keys and the timeline's marker keys (lib/dashboardConfig).
type DashSection = "kpis" | "timeline";
function DashboardTab({ toast }: { toast: Toast }) {
  const [cfg, setCfg] = useState<DashboardConfig>({});
  const [roles, setRoles] = useState<{ name: string }[]>([]);
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  // Which KPI category bands are expanded in this editor (all collapsed by default so the list stays short).
  const [openCats, setOpenCats] = useState<Set<KpiCategory>>(new Set());
  const toggleCat = (cat: KpiCategory) => setOpenCats((s) => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
  useEffect(() => {
    getSetting<DashboardConfig>("dashboard").then((s) => setCfg(s.value ?? {})).catch(() => {}).finally(() => setReady(true));
    list<{ name: string }>("roles").then((r) => setRoles(r.results ?? [])).catch(() => setRoles([]));
  }, []);
  const setAud = (section: DashSection, key: string, aud: Audience) =>
    setCfg((c) => ({ ...c, [section]: { ...(c[section] ?? {}), [key]: aud } }));
  // Toggle a whole KPI category off/on org-wide (coarse switch above the per-card audience rules).
  const hiddenCats = cfg.hiddenKpiCategories ?? [];
  const setCatHidden = (cat: KpiCategory, hidden: boolean) =>
    setCfg((c) => {
      const set = new Set(c.hiddenKpiCategories ?? []);
      if (hidden) set.add(cat); else set.delete(cat);
      return { ...c, hiddenKpiCategories: [...set] };
    });
  // Both sections live in the one `settings/dashboard` blob, so each save persists the whole `cfg` (KPIs +
  // markers); the two buttons just let you save from where you're working, with a section-specific toast.
  const { markSaved } = useUnsaved(cfg, ready, () => save("Dashboard settings saved"));
  async function save(savedMsg: string) {
    setSaving(true);
    try {
      await saveSetting("dashboard", { value: cfg });
      markSaved();
      toast({ title: savedMsg, variant: "success" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }
  const section = (defs: { key: string; label: string }[], sec: DashSection, saveLabel: string, savedMsg: string, emptyLabel: string) => (
    <div className="space-y-2">
      <div className="divide-y rounded-lg border">
        {defs.map((d) => (
          <div key={d.key} className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="text-sm font-medium sm:w-48 sm:shrink-0">{d.label}</span>
            <AudienceCell value={cfg[sec]?.[d.key]} roles={roles} employees={employees} defaultLabel={emptyLabel} onChange={(a) => setAud(sec, d.key, a)} />
          </div>
        ))}
      </div>
      <Button onClick={() => save(savedMsg)} disabled={!ready || saving}><Save className="h-4 w-4" /> {saveLabel}</Button>
    </div>
  );
  // KPI cards grouped into collapsible category bands. Each header carries: a checkbox that hides the whole
  // category org-wide, the category icon + label, a "shared / total" badge, and a chevron to expand the band's
  // per-card audience rows. Bands start collapsed so the list stays short - open only the one you're editing.
  const kpiSection = () => (
    <div className="space-y-2">
      {KPI_CATEGORIES.map((cat) => {
        const CatIcon = CATEGORY_ICONS[cat.key];
        const hidden = hiddenCats.includes(cat.key);
        const open = openCats.has(cat.key);
        const defs = KPI_DEFS.filter((d) => d.category === cat.key);
        // How many cards in this band are visible to someone beyond super admins: Everyone, an explicit
        // role/person audience, or an unconfigured card whose default audience isn't "none". Empty = hidden.
        const shared = defs.filter((d) => {
          const a = cfg.kpis?.[d.key];
          if (!a) return KPI_DEFAULT_AUDIENCE[d.key] !== "none"; // unconfigured -> code default
          return !!a.everyone || (a.roles?.length ?? 0) + (a.employees?.length ?? 0) > 0;
        }).length;
        return (
          <div key={cat.key} className={cn("rounded-lg border", hidden && "opacity-60")}>
            <div className="flex items-center gap-2 px-3 py-2">
              <Checkbox checked={!hidden} onCheckedChange={(v) => setCatHidden(cat.key, v !== true)} aria-label={`Show ${cat.label} band`} />
              <button type="button" onClick={() => toggleCat(cat.key)} className="flex flex-1 items-center gap-2 text-left">
                <CatIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-semibold">{cat.label}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{hidden ? "Hidden" : `${shared}/${defs.length} shared`}</span>
                <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
              </button>
            </div>
            {open && (
              <div className="divide-y border-t">
                {defs.map((d) => {
                  const Icon = KPI_ICONS[d.key];
                  return (
                    // The 192px label column plus an audience control is more than a phone has; below `sm`
                    // the control takes the line under the name it belongs to.
                    <div key={d.key} className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                      <span className="flex items-center gap-2 text-sm font-medium sm:w-48 sm:shrink-0">
                        {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                        {d.label}
                      </span>
                      <AudienceCell value={cfg.kpis?.[d.key]} roles={roles} employees={employees} defaultLabel={{ everyone: "Everyone (default)", hr: "HR Admin (default)", none: "No one · hidden" }[KPI_DEFAULT_AUDIENCE[d.key]]} onChange={(a) => setAud("kpis", d.key, a)} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <Button onClick={() => save("KPI visibility saved")} disabled={!ready || saving}><Save className="h-4 w-4" /> Save KPIs</Button>
    </div>
  );
  // Shortcut tiles at the bottom of the dashboard: an ordered pick from every quick-create action and every
  // page/tab in the app. Unset = the built-in default set; clearing the list switches the row off. Capability
  // gating still applies per person at render, so a tile only shows to people who can use it.
  const shortcuts = cfg.shortcuts ?? DEFAULT_DASHBOARD_SHORTCUTS;
  const setShortcuts = (ids: string[]) => setCfg((c) => ({ ...c, shortcuts: ids }));
  const shortcutSection = () => {
    const catalog = shortcutCatalog();
    const byId = new Map(catalog.map((s) => [s.id, s]));
    const chosen = shortcuts.filter((id) => byId.has(id));
    const available = catalog.filter((s) => !chosen.includes(s.id));
    const move = (i: number, dir: -1 | 1) => {
      const j = i + dir;
      if (j < 0 || j >= chosen.length) return;
      const n = [...chosen];
      [n[i], n[j]] = [n[j], n[i]];
      setShortcuts(n);
    };
    return (
      <div className="space-y-2">
        {chosen.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">No shortcuts - the tile row is hidden on the dashboard.</p>
        ) : (
          <div className="space-y-1.5">
            {chosen.map((id, i) => {
              const s = byId.get(id)!;
              const Icon = s.icon;
              return (
                <div key={id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate text-sm">{s.label}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{s.kind === "action" ? "Action" : "Page"}</span>
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setShortcuts(chosen.filter((x) => x !== id))} aria-label="Remove shortcut"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select value="" onValueChange={(v) => setShortcuts([...chosen, v])}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-72"><SelectValue placeholder="Add a shortcut..." /></SelectTrigger>
            <SelectContent>
              {available.map((s) => <SelectItem key={s.id} value={s.id}>{s.kind === "action" ? `${s.detail}: ${s.label}` : s.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={() => setShortcuts([...DEFAULT_DASHBOARD_SHORTCUTS])}>Reset to default</Button>
        </div>
        <Button onClick={() => save("Dashboard shortcuts saved")} disabled={!ready || saving}><Save className="h-4 w-4" /> Save shortcuts</Button>
      </div>
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction collection="settings" objectPath="settings/dashboard" label="Dashboard"><span>Dashboard</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Choose who sees each KPI card and timeline marker, and which shortcut tiles the dashboard ends with. Selecting no one hides an item.</p>
        <Tabs defaultValue="kpis">
          <TabsList variant="segmented">
            <TabsTrigger value="kpis">KPI cards</TabsTrigger>
            <TabsTrigger value="timeline">Timeline markers</TabsTrigger>
            <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>
          </TabsList>
          <TabsContent value="kpis">{kpiSection()}</TabsContent>
          <TabsContent value="timeline">{section(MARKER_DEFS, "timeline", "Save markers", "Timeline markers saved", "Everyone")}</TabsContent>
          <TabsContent value="shortcuts">{shortcutSection()}</TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// "Visible to" editor for one dashboard item: a compact summary button that opens a popover with an Everyone
// toggle, role toggles and a searchable people list. Audience = { everyone?, roles[], employees[] } (OR semantics).
// An UNCONFIGURED item (value === undefined) shows `defaultLabel` (the code default). A configured item that
// names no one is DISABLED - nobody sees it. Picking a role/person turns Everyone off (they're distinct modes).
function AudienceCell({ value, roles, employees, defaultLabel = "Everyone", onChange }: { value: Audience | undefined; roles: { name: string }[]; employees: Employee[]; defaultLabel?: string; onChange: (a: Audience) => void }) {
  const [q, setQ] = useState("");
  const everyone = value?.everyone === true;
  const selRoles = value?.roles ?? [];
  const selEmps = value?.employees ?? [];
  const configured = value !== undefined;
  const named = selRoles.length + selEmps.length > 0; // explicitly targets some roles/people
  const setEveryone = () => onChange(everyone ? {} : { everyone: true }); // toggle; off => disabled ({})
  const toggleRole = (r: string) => onChange({ roles: selRoles.includes(r) ? selRoles.filter((x) => x !== r) : [...selRoles, r], employees: selEmps });
  const toggleEmp = (id: string) => onChange({ roles: selRoles, employees: selEmps.includes(id) ? selEmps.filter((x) => x !== id) : [...selEmps, id] });
  const nameOf = (id: string) => { const e = employees.find((x) => idOf(x.path) === id); return e ? `${e.first_name} ${e.last_name}` : id; };
  const ql = q.trim().toLowerCase();
  const filtered = ql ? employees.filter((e) => `${e.first_name} ${e.last_name}`.toLowerCase().includes(ql)) : employees;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 flex-1 justify-between gap-2">
          <span className="flex items-center gap-1 overflow-hidden">
            <span className="shrink-0 text-xs font-normal text-muted-foreground">Visible to:</span>
            {!configured ? (
              <span className="text-xs font-medium text-muted-foreground">{defaultLabel}</span>
            ) : everyone ? (
              <span className="text-xs font-medium">Everyone</span>
            ) : !named ? (
              <span className="text-xs font-medium text-warning">No one · hidden</span>
            ) : (
              <span className="flex items-center gap-1 overflow-hidden">
                {selRoles.map((r) => (
                  <span key={r} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                    <Users className="h-2.5 w-2.5" />{roleLabel(r)}
                  </span>
                ))}
                {selEmps.map((id) => (
                  <span key={id} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    <User className="h-2.5 w-2.5" />{nameOf(id)}
                  </span>
                ))}
              </span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {/* Everyone: the first, primary choice - visually distinct from the role/person options below it. */}
        <div className="p-2">
          <button type="button" onClick={setEveryone} className={cn("flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors", everyone ? "border-primary bg-primary text-primary-foreground" : "border-primary/40 bg-primary/5 hover:bg-primary/10")}>
            <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", everyone ? "bg-primary-foreground/20" : "bg-primary/10 text-primary")}>
              <Globe className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Everyone</span>
              <span className={cn("block text-[11px]", everyone ? "text-primary-foreground/80" : "text-muted-foreground")}>All employees see this card</span>
            </span>
            {everyone && <Check className="ml-auto h-4 w-4 shrink-0" />}
          </button>
        </div>
        <div className="border-y p-2">
          <p className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">Or limit to roles</p>
          <div className="flex flex-wrap gap-1">
            {roles.map((r) => (
              <button key={r.name} type="button" onClick={() => toggleRole(r.name)} className={cn("rounded-full border px-2 py-0.5 text-xs", selRoles.includes(r.name) ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")}>
                {roleLabel(r.name)}
              </button>
            ))}
          </div>
        </div>
        <div className="p-2">
          <p className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">Specific people</p>
          <Input type="search" className="mb-1.5 h-8" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {filtered.map((e) => {
              const id = idOf(e.path);
              return (
                <label key={e.path} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                  <Checkbox checked={selEmps.includes(id)} onCheckedChange={() => toggleEmp(id)} /> {e.first_name} {e.last_name}
                </label>
              );
            })}
            {filtered.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No matches.</p>}
          </div>
        </div>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">Pick Everyone, or specific roles/people. Nothing selected = hidden (no one sees it).</p>
      </PopoverContent>
    </Popover>
  );
}

// Org-wide defaults (settings/probation + settings/holidays): the default probation length applied to new
// employees and the per-employee optional-holiday allowance. Lives under Organization, not leave policy.
function DefaultsTab({ toast }: { toast: Toast }) {
  const [probation, setProbation] = useState("3");
  const [maxOptional, setMaxOptional] = useState("2");
  const [pickBy, setPickBy] = useState("");
  const [reminderDays, setReminderDays] = useState("7");
  const [feedEnabled, setFeedEnabled] = useState(false);
  const [compOff, setCompOff] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const writeSettings = useSettingsBatch();

  useEffect(() => {
    void Promise.allSettled([
      getSetting<{ default_months?: number }>("probation")
        .then((s) => typeof s.value?.default_months === "number" && setProbation(String(s.value.default_months))),
      getSetting<{ max_optional?: number; pick_by?: string; pick_reminder_days?: number; feed_enabled?: boolean; comp_off_on_holiday_work?: boolean }>("holidays")
        .then((s) => {
          if (typeof s.value?.max_optional === "number") setMaxOptional(String(s.value.max_optional));
          if (s.value?.pick_by) setPickBy(s.value.pick_by.slice(0, 10));
          if (typeof s.value?.pick_reminder_days === "number") setReminderDays(String(s.value.pick_reminder_days));
          setFeedEnabled(!!s.value?.feed_enabled);
          setCompOff(!!s.value?.comp_off_on_holiday_work);
        }),
    ]).then(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ probation, maxOptional, pickBy, reminderDays, feedEnabled, compOff }, ready, save);
  async function save() {
    setSaving(true);
    try {
      // Two independent keys: a failure on the second used to commit the first and then report that nothing
      // was saved. `writeSettings` says what landed and lets the retry pick up where it stopped.
      const r = await writeSettings([
        { key: "probation", label: "The probation default", value: { default_months: Number(probation) } },
        {
          key: "holidays",
          label: "The holiday policy",
          value: {
            max_optional: Number(maxOptional),
            pick_by: pickBy || null,
            pick_reminder_days: Number(reminderDays) || 0,
            feed_enabled: feedEnabled,
            comp_off_on_holiday_work: compOff,
          },
        },
      ]);
      if (!r.ok) {
        toast(batchError(r));
        return;
      }
      markSaved();
      toast({ title: "Policies saved", variant: "success" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-4 sm:pt-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default probation period (months)" hint="Used to default an employee's probation end from their start date.">
            <Input type="number" min={0} value={probation} onChange={(e) => setProbation(e.target.value)} />
          </Field>
          <Field label="Max optional holidays per employee" hint="How many optional holidays each employee may pick.">
            <Input type="number" min={0} value={maxOptional} onChange={(e) => setMaxOptional(e.target.value)} />
          </Field>
          <Field label="Optional picks close on" hint="Deadline shown on the holiday page. Blank = no deadline.">
            <Input type="date" value={pickBy} onChange={(e) => setPickBy(e.target.value)} />
          </Field>
          <Field label="Remind this many days before" hint="Anyone with picks still unused gets one nudge then, and another on the day.">
            <Input type="number" min={0} value={reminderDays} onChange={(e) => setReminderDays(e.target.value)} disabled={!pickBy} />
          </Field>
        </div>
        {/* A subscribable feed is served OUTSIDE the session (a calendar client has none), so it is opt-in. */}
        <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
          <Checkbox checked={feedEnabled} onCheckedChange={(v) => setFeedEnabled(v === true)} className="mt-0.5" />
          <span>
            <span className="font-medium">Let employees subscribe to their holidays</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Adds a personal, unguessable calendar URL (Google Calendar / Outlook) to each employee's holiday
              page, kept in sync with their days off and picks. The URL needs no sign-in, so anyone it is shared
              with can read that person's holiday list - nothing else.
            </span>
          </span>
        </label>
        {/* The overtime lane covers the same ground for orgs that pay for it, so this is a choice, not a default. */}
        <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
          <Checkbox checked={compOff} onCheckedChange={(v) => setCompOff(v === true)} className="mt-0.5" />
          <span>
            <span className="font-medium">Credit comp-off when someone works a holiday</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              The nightly job adds a day (or half a day, by the attendance thresholds) of "Compensatory Off"
              leave to anyone whose punches show they worked a holiday that applied to them. Needs a leave type
              named Compensatory Off.
            </span>
          </span>
        </label>
        <Button onClick={save} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save defaults</Button>
      </CardContent>
    </Card>
  );
}

// Employee ID format (settings/employee-number): the scheme new hires are auto-numbered from (HR-overridable
// per employee). Sequence continues from the highest existing number, so changing the format only affects
// future auto-assignments; existing IDs are untouched.
type NumCfg = { prefix: string; separator: string; width: number; include_year: boolean; year_format: "YYYY" | "YY"; start: number };
const DEFAULT_NUM_CFG: NumCfg = { prefix: "EMP", separator: "-", width: 4, include_year: false, year_format: "YYYY", start: 1 };
// The ORG's year (lib/orgDay), as everywhere else. The server's `formatEmployeeNumber(cfg, seq, year)` takes
// the year as a parameter and stamps the JOINING year, so this preview is describing a different rule either
// way - but it should at least not describe a third one, read off the viewer's calendar.
function formatNum(c: NumCfg, seq: number): string {
  const parts: string[] = [];
  if (c.prefix) parts.push(c.prefix);
  if (c.include_year) parts.push(c.year_format === "YY" ? thisYearStr().slice(-2) : thisYearStr());
  parts.push(String(Math.max(0, seq)).padStart(Math.max(1, Math.min(12, c.width)), "0"));
  return parts.join(c.separator ?? "");
}
function EmployeeIdsTab({ toast }: { toast: Toast }) {
  const [cfg, setCfg] = useState<NumCfg>(DEFAULT_NUM_CFG);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const set = (p: Partial<NumCfg>) => setCfg((c) => ({ ...c, ...p }));

  useEffect(() => {
    getSetting<Partial<NumCfg>>("employee-number")
      .then((s) => s.value && setCfg({ ...DEFAULT_NUM_CFG, ...s.value }))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved(cfg, ready, save);
  async function save() {
    setSaving(true);
    try {
      await saveSetting("employee-number", { value: { ...cfg, width: Number(cfg.width), start: Number(cfg.start) } });
      markSaved();
      toast({ title: "Employee ID format saved", variant: "success" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-4 sm:pt-6">
        <p className="text-sm text-muted-foreground">
          New employees are auto-assigned an ID in this format (each is overridable on the employee's profile). The running number continues from the highest ID on file, so editing the format only changes future IDs.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Prefix" hint="Leading label. Leave blank for none.">
            <Input value={cfg.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="EMP" />
          </Field>
          <Field label="Separator" hint="Joins prefix / year / number. Leave blank for none.">
            <Input value={cfg.separator} onChange={(e) => set({ separator: e.target.value })} placeholder="-" />
          </Field>
          <Field label="Number width" hint="Zero-padded, e.g. 4 → 0042.">
            <Input type="number" min={1} max={12} value={cfg.width} onChange={(e) => set({ width: Number(e.target.value) })} />
          </Field>
          <Field label="Start at" hint="First number when there are no employees yet.">
            <Input type="number" min={0} value={cfg.start} onChange={(e) => set({ start: Number(e.target.value) })} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={cfg.include_year} onCheckedChange={(v) => set({ include_year: v === true })} className="mt-0.5" />
          <span>
            <span className="font-medium">Include the joining year</span>
            <span className="block text-xs text-muted-foreground">Inserts the current year between the prefix and the number.</span>
          </span>
        </label>
        {cfg.include_year && (
          <Field label="Year format">
            <Select value={cfg.year_format} onValueChange={(v) => set({ year_format: v as "YYYY" | "YY" })}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="YYYY">{thisYearStr()} (YYYY)</SelectItem>
                <SelectItem value="YY">{thisYearStr().slice(-2)} (YY)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        <div className="rounded-lg border bg-muted/40 p-3 text-sm">
          <span className="text-muted-foreground">Preview: </span>
          <span className="font-mono font-medium">{formatNum(cfg, Number(cfg.start) || 0)}</span>
          <span className="mx-2 text-muted-foreground">→</span>
          <span className="font-mono font-medium">{formatNum(cfg, (Number(cfg.start) || 0) + 1)}</span>
          <span className="mx-2 text-muted-foreground">→</span>
          <span className="font-mono font-medium">{formatNum(cfg, (Number(cfg.start) || 0) + 2)}</span>
        </div>
        <Button onClick={save} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save format</Button>
      </CardContent>
    </Card>
  );
}

// Asset tag printing (settings/asset-tags): the org-wide tag pattern (prefix/separator/digits), the
// sticker-sheet formats offered in the printer (presets + org-specific custom grids) and the default QR/label
// content. The code in the middle of a tag comes from the asset's category, so it is edited in the Categories
// tab (asset-categories), not here. Device-specific state (printer offsets, used-slot map) deliberately stays
// on each device - only policy lives here.
function AssetTagsTab({ toast, openId }: { toast: Toast; openId?: string }) {
  const { org } = useOrg();
  const [cfg, setCfg] = useState<AssetTagSettings>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<AssetTagSettings>) => setCfg((c) => ({ ...c, ...p }));

  useEffect(() => {
    getSetting<AssetTagSettings>("asset-tags")
      .then((s) => s.value && setCfg(s.value))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const { markSaved } = useUnsaved(cfg, loaded, save);
  async function save() {
    setSaving(true);
    try {
      const digits = cfg.digits != null ? Number(cfg.digits) : undefined;
      // Blank-id custom format rows are editing scaffolding; a saved row's label falls back to its id.
      const customs = (cfg.custom_formats ?? []).filter((f) => f.id.trim()).map((f) => ({ ...f, id: f.id.trim(), label: f.label.trim() || f.id.trim() }));
      await saveSetting("asset-tags", { value: { ...cfg, digits, custom_formats: customs.length ? customs : undefined } });
      markSaved();
      toast({ title: "Asset tag settings saved", variant: "success" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  const resolved = resolveTagConfig(org.name, cfg);
  const customs = cfg.custom_formats ?? [];
  const label = { ...DEFAULT_TAG_SETTINGS.label, ...(cfg.label ?? {}) };
  const setCustom = (i: number, p: Partial<SheetFormat>) => set({ custom_formats: customs.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const customKeys = useRowKeys(customs);
  // Custody rides in the same blob; an absent block means "all defaults", which are the enforcing ones.
  const custody = cfg.custody ?? {};
  const setCustody = (p: Partial<AssetCustodySettings>) => set({ custody: { ...custody, ...p } });

  if (!loaded) return <PanelSkeleton />;
  return (
    <div className="space-y-4">
      <Tabs defaultValue="pattern">
        <TabsList variant="segmented">
          <TabsTrigger value="pattern">Tag pattern</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="sheets">Sticker sheets & label</TabsTrigger>
          <TabsTrigger value="custody">Custody</TabsTrigger>
          <TabsTrigger value="found">Found-it page</TabsTrigger>
        </TabsList>

        <TabsContent value="pattern">
          <Card>
            <CardHeader><CardTitle className="text-base">Tag pattern</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Every asset is tagged in this pattern the moment it is added, with the code coming from its category and the number running per code. Tags already issued are never rewritten.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Prefix" hint={`Blank = your org initials (${resolveTagConfig(org.name).prefix}).`}>
                  <Input value={cfg.prefix ?? ""} onChange={(e) => set({ prefix: e.target.value })} placeholder={resolveTagConfig(org.name).prefix} />
                </Field>
                <Field label="Separator">
                  <Input value={cfg.separator ?? DEFAULT_TAG_SETTINGS.separator} onChange={(e) => set({ separator: e.target.value })} placeholder="-" />
                </Field>
                <Field label="Number width" hint="Zero-padded, e.g. 3 → 042.">
                  <Input type="number" min={1} max={6} value={cfg.digits ?? DEFAULT_TAG_SETTINGS.digits} onChange={(e) => set({ digits: Number(e.target.value) })} />
                </Field>
              </div>
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <span className="text-muted-foreground">Preview: </span>
                <span className="font-mono font-medium">{formatTag(resolved, "LAP", 1)}</span>
                <span className="mx-2 text-muted-foreground">→</span>
                <span className="font-mono font-medium">{formatTag(resolved, "LAP", 2)}</span>
                <span className="mx-2 text-muted-foreground">→</span>
                <span className="font-mono font-medium">{formatTag(resolved, "MON", 1)}</span>
                <p className="mt-1 text-xs text-muted-foreground">LAP and MON are category codes; an uncategorised asset uses {FALLBACK_TAG_CODE}.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="categories">
          <AssetCategories embedded openId={openId} />
        </TabsContent>

        <TabsContent value="sheets">
          <Card>
            <CardHeader><CardTitle className="text-base">Sticker sheets & label</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Default sheet format" hint="What the printer opens with.">
                  <Select value={cfg.default_format ?? DEFAULT_TAG_SETTINGS.default_format} onValueChange={(v) => set({ default_format: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{allFormats(cfg).map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label="Code type" hint="Code 128 suits existing 1D laser scanners; it always encodes the plain tag.">
                  <Select value={cfg.code_type ?? "qr"} onValueChange={(v) => set({ code_type: v as "qr" | "code128" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="qr">QR code</SelectItem>
                      <SelectItem value="code128">Code 128 barcode</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="QR code encodes" hint="Deep link opens the asset in the app when scanned.">
                  <Select value={cfg.qr_mode ?? DEFAULT_TAG_SETTINGS.qr_mode} onValueChange={(v) => set({ qr_mode: v as AssetTagSettings["qr_mode"] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="link">Link to the asset record</SelectItem>
                      <SelectItem value="found">Public found-it page</SelectItem>
                      <SelectItem value="tag">Tag text only</SelectItem>
                      <SelectItem value="tag_serial">Tag + serial number</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Label footer (optional)" hint='Small last line on every label, e.g. "If found: hr@company.com".'>
                  <Input maxLength={120} value={cfg.label?.footer ?? ""} onChange={(e) => set({ label: { ...(cfg.label ?? {}), footer: e.target.value || undefined } })} />
                </Field>
              </div>
              <div>
                <div className="mb-1 text-sm font-medium">Label shows</div>
                <div className="grid gap-1.5 text-sm sm:grid-cols-2">
                  <label className="flex items-center gap-2"><Checkbox checked={label.name} onCheckedChange={(v) => set({ label: { ...label, name: v === true } })} /> Asset name</label>
                  <label className="flex items-center gap-2"><Checkbox checked={label.serial} onCheckedChange={(v) => set({ label: { ...label, serial: v === true } })} /> Serial number</label>
                  <label className="flex items-center gap-2"><Checkbox checked={label.org} onCheckedChange={(v) => set({ label: { ...label, org: v === true } })} /> Organization name</label>
                  <label className="flex items-center gap-2"><Checkbox checked={label.logo} onCheckedChange={(v) => set({ label: { ...label, logo: v === true } })} /> Logo instead of the name</label>
                </div>
              </div>
              <div>
                <div className="mb-1 text-sm font-medium">Custom sheet formats</div>
                <p className="mb-2 text-xs text-muted-foreground">
                  For sticker stock the presets don't cover. All measurements in mm; reusing a preset's id ({SHEET_FORMATS.map((f) => f.id).join(", ")}) replaces that preset's geometry.
                </p>
                <div className="space-y-3">
                  {customs.map((f, i) => (
                    <div key={customKeys[i]} className="rounded-md border p-3">
                      <div className="editor-row mb-2">
                        <Input className="w-24 font-mono sm:w-32" value={f.id} placeholder="id" onChange={(e) => setCustom(i, { id: e.target.value })} />
                        <Input className="editor-row-main" value={f.label} placeholder="Shown in the format picker" onChange={(e) => setCustom(i, { label: e.target.value })} />
                        <Button variant="ghost" size="sm" aria-label="Remove format" onClick={() => set({ custom_formats: customs.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                      </div>
                      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                        {([["cols", "Cols"], ["rows", "Rows"], ["w", "W"], ["h", "H"], ["marginX", "Mgn X"], ["marginY", "Mgn Y"], ["gapX", "Gap X"], ["gapY", "Gap Y"]] as const).map(([k, lbl]) => (
                          <label key={k} className="text-xs text-muted-foreground">
                            {lbl}
                            <Input type="number" step={k === "cols" || k === "rows" ? 1 : 0.05} value={f[k]} onChange={(e) => setCustom(i, { [k]: Number(e.target.value) } as Partial<SheetFormat>)} />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => set({ custom_formats: [...customs, { id: "", label: "", cols: 3, rows: 8, w: 63.5, h: 33.9, marginX: 7.25, marginY: 12.9, gapX: 2.5, gapY: 0 }] })}>
                    <Plus className="h-4 w-4" /> Add format
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="found">
          <Card>
            <CardHeader><CardTitle className="text-base">Public "found it" page</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                When enabled, a sticker's QR can point at a public page (no sign-in) showing the org name, the tag and a return contact - so a stranger who finds lost hardware knows where to send it.
                The link is unguessable per asset; nothing else about the asset is exposed.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={cfg.found_page?.enabled ?? false} onCheckedChange={(v) => set({ found_page: { ...(cfg.found_page ?? {}), enabled: v === true } })} />
                Enable the public found-it page
              </label>
              {cfg.found_page?.enabled && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Return contact" hint="Email or phone shown to the finder.">
                      <Input maxLength={200} value={cfg.found_page?.contact ?? ""} onChange={(e) => set({ found_page: { ...(cfg.found_page ?? {}), contact: e.target.value } })} placeholder="hr@company.com" />
                    </Field>
                    <label className="flex items-center gap-2 self-end pb-2 text-sm">
                      <Checkbox checked={cfg.found_page?.show_name ?? false} onCheckedChange={(v) => set({ found_page: { ...(cfg.found_page ?? {}), show_name: v === true } })} />
                      Also show the asset's display name
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Deployments behind Cloudflare Access need a bypass rule for <span className="font-mono">/found/*</span> in the Access app config, or outsiders hit the login wall instead of the page.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="custody">
          <Card>
            <CardHeader><CardTitle className="text-base">Custody by scan</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                With these on, an asset's whereabouts are only ever recorded by someone scanning its printed tag: a new or returned
                item waits in <span className="font-medium">Awaiting check-in</span> until an admin scans it into stock, and an
                assigned one waits in <span className="font-medium">Awaiting holder</span> until the person it was given to scans it.
                Turn them off and assignment is recorded on trust, as a plain form edit.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={custody.stock_scan_required !== false} onCheckedChange={(v) => setCustody({ stock_scan_required: v === true })} />
                Require a scan to count an asset into stock
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={custody.ack_required !== false} onCheckedChange={(v) => setCustody({ ack_required: v === true })} />
                Require the holder to confirm what they were given
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={custody.manual_ack_allowed === true} onCheckedChange={(v) => setCustody({ manual_ack_allowed: v === true })} />
                Let holders confirm without scanning (for destroyed stickers) - recorded as an unscanned confirmation
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Chase after (days)" hint="How long an unconfirmed hand-over waits before the holder - then their manager - is nudged.">
                  <Input type="number" min={1} max={90} value={custody.ack_reminder_days ?? 3} onChange={(e) => setCustody({ ack_reminder_days: Number(e.target.value) })} />
                </Field>
                <Field label="Goes stale after (days)" hint="Time since the last sighting before an asset is flagged for a stocktake.">
                  <Input type="number" min={7} max={3650} value={custody.verify_stale_days ?? 180} onChange={(e) => setCustody({ verify_stale_days: Number(e.target.value) })} />
                </Field>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* One blob, one Save: it persists every tab, not just the visible one. */}
      <Button onClick={save} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save asset tag settings</Button>
    </div>
  );
}

// Org-wide leave caps (settings/leave_caps): whether encashment + carry-forward caps are taken per leave type
// or as one cumulative cap across all types, and what happens to carry-forward excess (auto-encash or forfeit).
function LeaveCapsTab({ toast }: { toast: Toast }) {
  const [excess, setExcess] = useState<"encash" | "forfeit">("encash");
  const [cfMode, setCfMode] = useState<"per_type" | "cumulative">("per_type");
  const [cfCap, setCfCap] = useState("");
  const [encMode, setEncMode] = useState<"per_type" | "cumulative">("per_type");
  const [encCap, setEncCap] = useState("");
  const [encRateBasis, setEncRateBasis] = useState<"base" | "gross">("base");
  const [encDivisor, setEncDivisor] = useState("30");
  const [rounding, setRounding] = useState<"none" | "half" | "day">("half");
  const [allowBackdated, setAllowBackdated] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const writeSettings = useSettingsBatch();

  useEffect(() => {
    void Promise.allSettled([
      getSetting<Record<string, unknown>>("leave_caps")
        .then((s) => {
          const v = s.value ?? {};
          if (v.carry_forward_excess === "forfeit") setExcess("forfeit");
          if (v.carry_forward_mode === "cumulative") setCfMode("cumulative");
          if (typeof v.carry_forward_cumulative_cap_days === "number") setCfCap(String(v.carry_forward_cumulative_cap_days));
          if (v.encashment_mode === "cumulative") setEncMode("cumulative");
          if (typeof v.encashment_cumulative_cap_days === "number") setEncCap(String(v.encashment_cumulative_cap_days));
        }),
      getSetting<{ rate_basis?: string; per_day_divisor?: number }>("leave_encashment")
        .then((s) => { if (s.value?.rate_basis === "gross") setEncRateBasis("gross"); if (typeof s.value?.per_day_divisor === "number") setEncDivisor(String(s.value.per_day_divisor)); }),
      getSetting<{ rounding?: string }>("leave_accrual")
        .then((s) => { const r = s.value?.rounding; if (r === "none" || r === "half" || r === "day") setRounding(r); }),
      getSetting<{ allow_backdated?: boolean }>("leave-requests")
        .then((s) => { if (typeof s.value?.allow_backdated === "boolean") setAllowBackdated(s.value.allow_backdated); }),
    ]).then(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved(
    { excess, cfMode, cfCap, encMode, encCap, encRateBasis, encDivisor, rounding, allowBackdated },
    ready,
    save,
  );
  async function save() {
    setSaving(true);
    try {
      // FOUR independent keys, all of which feed payroll and the leave engine. A failure on the third left the
      // first two in force under a toast saying the save did not happen - carry-forward caps and the encashment
      // rate basis applying, accrual rounding and back-dating not, with nothing on screen to tell that apart
      // from a save that did nothing at all.
      const r = await writeSettings([
        {
          key: "leave_caps",
          label: "Carry-forward caps",
          value: {
            carry_forward_excess: excess,
            carry_forward_mode: cfMode,
            carry_forward_cumulative_cap_days: cfCap.trim() === "" ? null : Number(cfCap),
            encashment_mode: encMode,
            encashment_cumulative_cap_days: encCap.trim() === "" ? null : Number(encCap),
          },
        },
        { key: "leave_encashment", label: "the encashment rate", value: { rate_basis: encRateBasis, per_day_divisor: encDivisor.trim() === "" ? 30 : Number(encDivisor) } },
        { key: "leave_accrual", label: "accrual rounding", value: { rounding } },
        { key: "leave-requests", label: "back-dating", value: { allow_backdated: allowBackdated } },
      ]);
      if (!r.ok) {
        toast(batchError(r));
        return;
      }
      markSaved();
      toast({ title: "Leave policy saved", variant: "success" });
    } catch (e) {
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/leave_caps" label="Leave policy"><span>Policy</span></AccessAction></CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <Tabs defaultValue="carry-forward">
          <TabsList variant="segmented">
            <TabsTrigger value="carry-forward">Carry-forward</TabsTrigger>
            <TabsTrigger value="encashment">Encashment</TabsTrigger>
            <TabsTrigger value="accrual">Accrual</TabsTrigger>
            <TabsTrigger value="requests">Requests</TabsTrigger>
          </TabsList>

          <TabsContent value="carry-forward" className="space-y-3">
            <p className="text-xs text-muted-foreground">Year-end rollover of unused balance.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cap basis" hint="Per type uses each leave type's own cap; cumulative caps the total across all carry-forward types.">
                <Select value={cfMode} onValueChange={(v) => setCfMode(v as "per_type" | "cumulative")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_type">Per leave type</SelectItem>
                    <SelectItem value="cumulative">Cumulative (all types)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Cumulative cap (days)" hint="Total days that carry over across all types. Used only in cumulative mode.">
                <Input type="number" min={0} value={cfCap} disabled={cfMode !== "cumulative"} placeholder="No cap" onChange={(e) => setCfCap(e.target.value)} />
              </Field>
            </div>
            <Field label="Excess handling" hint="What happens to balance above the carry-forward cap at year end.">
              <Select value={excess} onValueChange={(v) => setExcess(v as "encash" | "forfeit")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="encash">Auto-encash (up to the encashment cap)</SelectItem>
                  <SelectItem value="forfeit">Forfeit</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </TabsContent>

          <TabsContent value="encashment" className="space-y-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cap basis" hint="Per type uses each leave type's own annual cap; cumulative caps the total encashed across all types per calendar year.">
                <Select value={encMode} onValueChange={(v) => setEncMode(v as "per_type" | "cumulative")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_type">Per leave type</SelectItem>
                    <SelectItem value="cumulative">Cumulative (all types)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Cumulative cap (days/year)" hint="Total encashable per calendar year across all types. Used only in cumulative mode.">
                <Input type="number" min={0} value={encCap} disabled={encMode !== "cumulative"} placeholder="No cap" onChange={(e) => setEncCap(e.target.value)} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Payout rate basis" hint="Per-day encashment rate = this monthly amount / divisor. Base pay (parity with FnF) or monthly recurring gross.">
                <Select value={encRateBasis} onValueChange={(v) => setEncRateBasis(v as "base" | "gross")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="base">Base pay</SelectItem>
                    <SelectItem value="gross">Monthly gross</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Per-day divisor" hint="Days the monthly amount is divided by for the per-day rate (default 30).">
                <Input type="number" min={1} value={encDivisor} placeholder="30" onChange={(e) => setEncDivisor(e.target.value)} />
              </Field>
            </div>
          </TabsContent>

          <TabsContent value="accrual">
            <Field label="Round accrued balances to" hint="Prorated joining months otherwise produce values like 2.41. Applied on the next accrual run.">
              <Select value={rounding} onValueChange={(v) => setRounding(v as "none" | "half" | "day")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="half">Half day (0.5)</SelectItem>
                  <SelectItem value="day">Whole day (1.0)</SelectItem>
                  <SelectItem value="none">Exact (no rounding)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </TabsContent>

          <TabsContent value="requests">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={allowBackdated} onCheckedChange={(v) => setAllowBackdated(v === true)} className="mt-0.5" />
              <span>Allow back-dated requests<span className="block text-xs text-muted-foreground">When off, employees can only request today or future dates. HR applying leave on someone's behalf can still back-date.</span></span>
            </label>
          </TabsContent>
        </Tabs>
        <Button onClick={save} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save leave policy</Button>
      </CardContent>
    </Card>
  );
}

function FieldsTab({ toast }: { toast: Toast }) {
  const [fields, setFields] = useState<EmployeeFieldDef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  // The keys the ORG has actually stored. A row that was never saved carries nobody's data, so removing it is
  // an edit; removing a saved one is what puts employees' PAN/Aadhaar values on the line.
  const savedKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    getSetting<{ fields?: EmployeeFieldDef[] }>("employee_fields")
      .then((s) => {
        const initial = s.value?.fields?.length ? s.value.fields : DEFAULT_FIELDS;
        savedKeys.current = new Set(initial.map((f) => f.key || slug(f.label)));
        setFields(initial);
      })
      .catch(() => setFields(DEFAULT_FIELDS))
      .finally(() => setLoaded(true));
  }, []);

  const update = (i: number, patch: Partial<EmployeeFieldDef>) =>
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  // Removing a field is a data decision, not a layout one: the values stop being shown, and on save the
  // server deletes them along with any uploaded proof (routes/settings.ts). Say so before the row vanishes.
  const remove = async (i: number) => {
    const f = fields[i];
    const key = f ? f.key || slug(f.label) : "";
    if (key && savedKeys.current.has(key)) {
      const ok = await confirm({
        title: `Remove ${f!.label.trim() || "this field"}?`,
        description:
          "When you save, every employee's stored value for this field is DELETED, along with any document uploaded as proof of it. This cannot be undone, and the exact count is confirmed again on save.",
        destructive: true,
        confirmLabel: "Remove field",
      });
      if (!ok) return;
    }
    setFields((fs) => fs.filter((_, idx) => idx !== i));
  };
  const fieldKeys = useRowKeys(fields);
  const add = () => setFields((fs) => [...fs, { key: "", label: "", mandatory: false, sensitive: false, document: "none" }]);

  const { markSaved } = useUnsaved(fields, loaded, save);
  async function save() {
    const cleaned = fields
      .filter((f) => f.label.trim())
      .map((f) => ({ key: f.key || slug(f.label), label: f.label.trim(), mandatory: !!f.mandatory, sensitive: !!f.sensitive, document: f.document ?? "none" }));
    const keys = cleaned.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      toast({ title: "Duplicate fields", description: "Two fields resolve to the same key. Rename one.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await saveSetting("employee_fields", { value: { fields: cleaned } });
      savedKeys.current = new Set(cleaned.map((f) => f.key));
      setFields(cleaned);
      markSaved();
      toast({ title: "Employee fields saved", variant: "success" });
    } catch (e) {
      // The server refuses a removal that would strand stored values, and its message names the fields and how
      // many employees hold one - the count this panel cannot know on its own. Put that sentence in front of
      // the admin and only then re-send with the confirmation flag, which deletes those values and the proofs
      // uploaded against them.
      const message = (e as Error).message ?? "";
      if (message.includes("delete_removed_values")) {
        const ok = await confirm({
          title: "Delete the stored values too?",
          description: `${message.replace(/ - re-send with delete_removed_values to confirm\.$/, ".")} Deleting cannot be undone. Cancel and add the field back to keep them.`,
          destructive: true,
          confirmLabel: "Delete the values",
        });
        if (ok) {
          try {
            // The confirmation travels inside the value and is consumed by the route, never stored
            // (routes/settings.ts).
            await saveSetting("employee_fields", { value: { fields: cleaned, delete_removed_values: true } });
            savedKeys.current = new Set(cleaned.map((f) => f.key));
            setFields(cleaned);
            markSaved();
            toast({ title: "Employee fields saved", description: "The removed fields' values and proofs were deleted.", variant: "success" });
            return;
          } catch (retryError) {
            toast(saveSettingError(retryError));
            return;
          } finally {
            setSaving(false);
          }
        }
      }
      toast(saveSettingError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base"><AccessAction collection="settings" objectPath="settings/employee_fields" label="Employee fields"><span>Employee identity fields</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Define the identity details collected for each employee (e.g. PAN, Aadhaar, UAN). Sensitive fields are
          shown masked; required fields must be filled before saving an employee's details.
        </p>
        {loaded && (
          <div>
            <div className="hidden grid-cols-[1fr_auto_auto_auto_auto] items-center gap-3 px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
              <span>Field label</span>
              <span className="w-20 text-center">Required</span>
              <span className="w-20 text-center">Sensitive</span>
              <span className="w-28 text-center">Document</span>
              <span className="w-8" />
            </div>
            <div className="divide-y rounded-lg border">
              {fields.map((f, i) => (
                // The five fixed columns add up to ~304px before the label input gets any width at all, which
                // on a phone means the row simply does not fit. Below `sm` the row becomes a small stacked
                // block: the label with its remove button, then the two flags as real labelled checkboxes
                // (the column headers they belonged to are hidden at this width, so unlabelled boxes would be
                // a guess), then the document setting. The grid returns unchanged from `sm` up.
                <div
                  key={fieldKeys[i]}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 p-2 sm:grid-cols-[1fr_auto_auto_auto_auto]"
                >
                  <Input value={f.label} placeholder="e.g. Passport number" onChange={(e) => update(i, { label: e.target.value })} />
                  <Button variant="ghost" size="icon" className="h-8 w-8 sm:hidden" onClick={() => void remove(i)} aria-label="Remove field">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  {/* One checkbox per flag either way - only the caption comes and goes. Below `sm` the
                      column headers are hidden, so the flag has to name itself. */}
                  <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-1 sm:w-20 sm:justify-center">
                    <Checkbox checked={f.mandatory} onCheckedChange={(v) => update(i, { mandatory: v === true })} />
                    <span className="sm:hidden">Required</span>
                  </label>
                  <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-1 sm:w-20 sm:justify-center">
                    <Checkbox checked={f.sensitive} onCheckedChange={(v) => update(i, { sensitive: v === true })} />
                    <span className="sm:hidden">Sensitive</span>
                  </label>
                  <select
                    className="col-span-2 h-9 min-w-0 rounded-md border bg-background px-2 text-sm coarse:min-h-10 sm:col-span-1 sm:w-28"
                    aria-label="Document requirement"
                    value={f.document ?? "none"}
                    onChange={(e) => update(i, { document: e.target.value as EmployeeFieldDef["document"] })}
                  >
                    <option value="none">No document</option>
                    <option value="allowed">Allowed</option>
                    <option value="required">Required</option>
                  </select>
                  <Button variant="ghost" size="icon" className="hidden h-8 w-8 sm:inline-flex" onClick={() => void remove(i)} aria-label="Remove field">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {fields.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">No fields. Add one below.</p>}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={add}><Plus className="h-4 w-4" /> Add field</Button>
          <Button onClick={save} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save fields</Button>
          <Badge variant="muted" className="sm:ml-auto">Applies to all employees</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
