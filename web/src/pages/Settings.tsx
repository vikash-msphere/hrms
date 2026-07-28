import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { navigate } from "@/router";
import { Plus, Trash2, Save, Building, X, ChevronDown, Users, User, Search, ArrowLeft, ArrowUp, ArrowDown, Check, Globe } from "lucide-react";
import { get, patch, create, remove, list } from "@/api";
import { SETTINGS_REGISTRY, SETTINGS_GROUPS, SETTINGS_LEGACY, settingsEntry, entryScope, type SettingsEntry } from "@/settings/registry";
import { BoardConfigPanel } from "@/settings/BoardConfigPanel";
import { NotificationPrefsPanel } from "@/components/notifications/NotificationPrefsPanel";
import { hasCapability } from "@/lib/perm";
import { APP_NAME } from "@/lib/brand";
import type { OrgSettings } from "@/lib/org";
import { roleLabel } from "@/lib/roles";
import { type Audience, type DashboardConfig, type KpiCategory, KPI_DEFS, KPI_CATEGORIES, KPI_DEFAULT_AUDIENCE, MARKER_DEFS } from "@/lib/dashboardConfig";
import { KPI_ICONS, CATEGORY_ICONS } from "@/lib/kpiIcons";
import { usePermission } from "@/lib/perm";
import { useOrg, currencyDecimals, orgNameFontStack, orgNameWeight, orgNameSizePx, NAME_FONTS, NAME_WEIGHTS, NAME_SIZES, type LetterDefaults } from "@/lib/org";
import { useCollection } from "@/hooks/useCollection";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";
import { SplitStaleBanner } from "@/components/common/SplitStaleBanner";
import { cn, idOf, formatMoney } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { EmployeeFieldDef, Employee, Department, TicketCategory, TicketChecklist, Me, AtsConfig, AtsStage } from "@/types";
import { DEFAULT_ATS_CONFIG } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { KudosLevelsTab } from "@/components/common/KudosLevelsTab";
import { RolesPanel } from "@/components/common/RolesPanel";
import { RolesManagePanel } from "@/components/common/RolesManagePanel";
import { PermissionsPanel } from "@/components/common/PermissionsPanel";
import { AccessTarget } from "@/components/access/AccessTarget";
import { AccessAction } from "@/components/access/AccessAction";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import PayComponents from "@/pages/PayComponents";
import PayGradesAdmin from "@/pages/PayGradesAdmin";
import SalaryStructuresAdmin from "@/pages/SalaryStructuresAdmin";
// Lazy: pulls in the xlsx parser only when the Bank formats tab is opened (keeps it out of the main bundle).
const BankFormats = lazy(() => import("@/pages/BankFormats"));
// Lazy: the letter-template editor (block editor + preview) is only loaded when its tab is opened.
const LettersTab = lazy(() => import("@/pages/LettersTab"));
// Lazy: the payslip-design editor (block editor + PDF preview), same reasoning as the letter editor.
const PayslipDesignTab = lazy(() => import("@/pages/PayslipDesignTab"));
import LeaveTypes from "@/pages/LeaveTypes";
import ReviewCycles from "@/pages/ReviewCycles";
import { PerformanceFramework } from "@/components/common/PerformanceFramework";
import { TransitionTemplatesEditor } from "@/components/common/TransitionTemplatesEditor";
import BenefitPlansAdmin from "@/pages/BenefitPlansAdmin";
import ShiftsAdmin from "@/pages/ShiftsAdmin";
import ProjectsAdmin from "@/pages/ProjectsAdmin";
import Departments from "@/pages/Departments";
import ReimbursementCategories from "@/pages/ReimbursementCategories";
import ExpenseCategories from "@/pages/ExpenseCategories";
import Operations from "@/pages/Operations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { CONFIGURABLE_QUICK_ACTIONS, normalizeQuickMenu, type QuickMenuGroup } from "@/lib/quickActions";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ShieldAlert } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
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
    get<{ value?: { events?: Record<string, EventCfg> } }>("settings/notifications")
      .then((s) => setEvents(s.value?.events ?? {}))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  const cfgOf = (c: { key: string; defaultPriority: string }): EventCfg => events[c.key] ?? { enabled: true, priority: c.defaultPriority };
  const setOne = (key: string, patchCfg: Partial<EventCfg>, def: string) =>
    setEvents((e) => ({ ...e, [key]: { ...(e[key] ?? { enabled: true, priority: def }), ...patchCfg } }));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      // Materialize every category so the saved blob is complete + explicit.
      const full = Object.fromEntries(NOTIF_CATEGORIES.map((c) => [c.key, cfgOf(c)]));
      await patch("settings/notifications", { value: { events: full } });
      toast({ title: "Notification settings saved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    } finally { setSaving(false); }
  }
  if (!ready) return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction objectPath="settings/notifications" label="Notification settings"><span>In-app notifications</span></AccessAction></CardTitle>
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

// Setup essentials a fresh org must configure before the app is genuinely usable. Probes are cheap:
// collections ride the client cache; identity comes from the org context that is already loaded app-wide.
function useEssentials(me: Me) {
  const { org } = useOrg();
  const depts = useCollection<{ path: string }>("departments");
  const leaveTypes = useCollection<{ path: string }>("leave-types");
  const payComponents = useCollection<{ path: string }>("pay-components");
  const templates = useCollection<{ path: string }>("letter-templates");
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
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
        <nav className="sticky top-4 max-h-[calc(100vh-2rem)] space-y-5 overflow-y-auto pb-4 pr-1">
          <button
            type="button"
            onClick={() => navigate("settings")}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All settings
          </button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings…" className="h-8 rounded-md pl-8 text-sm" />
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
        {renderSettingsPanel(entry.key, me, toast, slot, openId)}
      </div>
    </div>
  );
}

const panelLoading = <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;

export function renderSettingsPanel(key: string, me: Me, toast: Toast, slot: HTMLDivElement | null, openId?: string, objectPath?: string, onClose?: () => void) {
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
    case "payslip-design": return <Suspense fallback={panelLoading}><PayslipDesignTab toast={toast} /></Suspense>;
    case "reimbursements": return <ReimbursementsPanel toast={toast} openId={openId} />;
    case "expenses": return <ExpensesPanel toast={toast} openId={openId} />;
    case "bank-formats": return <Suspense fallback={panelLoading}><BankFormats toast={toast} /></Suspense>;
    case "projects": return <ProjectsAdmin openId={openId} />;
    // Hiring & growth
    case "recruiting": return <AtsTab toast={toast} />;
    case "referrals": return <ReferralsTab toast={toast} />;
    case "performance": return <div className="space-y-6"><PerformanceFramework /><ReviewCycles embedded /></div>;
    case "onboarding-templates": return <TransitionTemplatesEditor />;
    case "benefit-plans": return <BenefitPlansAdmin openId={openId} />;
    // Comms & support
    case "letters": return <Suspense fallback={panelLoading}><LettersTab toast={toast} /></Suspense>;
    case "letter-defaults": return <OrgLetterDefaultsPanel toast={toast} />;
    case "esign": return <EsignTab toast={toast} />;
    case "notifications": return <NotificationsTab toast={toast} />;
    case "ticket-categories": return <TicketsTab toast={toast} />;
    case "ticket-checklists": return <TicketChecklistsTab toast={toast} />;
    // Access & security
    case "users": return <RolesPanel me={me} controlsSlot={slot} />;
    case "roles": return <RolesManagePanel controlsSlot={slot} />;
    case "permissions": return <PermissionsPanel controlsSlot={slot} />;
    case "operations": return <Operations embedded />;
    default: return null;
  }
}

type Toast = ReturnType<typeof useToast>["toast"];

const MAX_LOGO_BYTES = 256 * 1024;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  useEffect(() => {
    get<{ value?: Partial<EsignCfg> }>("settings/esign").then((s) => { if (s.value) setCfg((p) => ({ ...p, ...s.value, providers: s.value!.providers ?? {} })); }).catch(() => {});
    get<{ providers: ProviderMeta[] }>("esign-providers").then((r) => setProviders(r.providers ?? [])).catch(() => {});
  }, []);
  const save = async () => { try { await patch("settings/esign", { value: cfg }); toast({ title: "E-signature settings saved" }); } catch (e) { toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) }); } };
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
// Payroll policy: CTC provisions (gratuity + employer ESI), overtime pricing, and Professional Tax slabs.
// Each is an independent settings blob (settings/ctc, settings/overtime, settings/professional-tax).
function PayrollPolicyTab({ toast }: { toast: Toast }) {
  const [ctc, setCtc] = useState({ basic_pct: 50, employer_pf_in_ctc: true });
  // Saving the CTC provisions changes how a stored annual CTC splits, so existing employees' cached splits can
  // go stale - shared signal with the pay-components / salary-structures panels.
  const { canReapply, staleCount, skippedCount, reapplying, reapply: doReapply, promptReapply } = useSplitStaleness();
  const [ot, setOt] = useState({ enabled: false, multiplier: 2, hours_per_month: 200, rate_per_hour: 0 });
  const [pt, setPt] = useState<{ slabs: { up_to: number | null; amount: number }[] }>({ slabs: [{ up_to: 25000, amount: 0 }, { up_to: null, amount: 200 }] });
  useEffect(() => {
    get<{ value?: Partial<typeof ctc> }>("settings/ctc").then((s) => { if (s.value) setCtc((p) => ({ ...p, ...s.value })); }).catch(() => {});
    get<{ value?: Partial<typeof ot> }>("settings/overtime").then((s) => { if (s.value) setOt((p) => ({ ...p, ...s.value, rate_per_hour: s.value!.rate_per_hour ?? 0 })); }).catch(() => {});
    get<{ value?: { slabs?: { up_to: number | null; amount: number }[] } }>("settings/professional-tax").then((s) => { if (s.value?.slabs?.length) setPt({ slabs: s.value.slabs }); }).catch(() => {});
  }, []);
  // Save the provisions, then offer to re-derive basic + Special Allowance for every current comp row under
  // them (CTC held fixed). Explicit because it shifts take-home org-wide - a config change alone never touches
  // existing rows.
  const saveCtc = async () => {
    try {
      await patch("settings/ctc", { value: ctc });
      toast({ title: "CTC provisions saved" });
      await promptReapply();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    }
  };
  const saveOt = async () => { try { await patch("settings/overtime", { value: { ...ot, rate_per_hour: ot.rate_per_hour > 0 ? ot.rate_per_hour : null } }); toast({ title: "Overtime policy saved" }); } catch (e) { toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) }); } };
  const savePt = async () => {
    const slabs = pt.slabs.map((s, i) => ({ up_to: i === pt.slabs.length - 1 ? null : Number(s.up_to) || 0, amount: Number(s.amount) || 0 }));
    try { await patch("settings/professional-tax", { value: { slabs } }); toast({ title: "Professional Tax slabs saved" }); } catch (e) { toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) }); }
  };
  const setSlab = (i: number, patchSlab: Partial<{ up_to: number | null; amount: number }>) => setPt((p) => ({ slabs: p.slabs.map((s, j) => (j === i ? { ...s, ...patchSlab } : s)) }));

  return (
    <Tabs defaultValue="ctc">
      <TabsList variant="segmented">
        <TabsTrigger value="ctc">CTC split</TabsTrigger>
        <TabsTrigger value="overtime">Overtime</TabsTrigger>
        <TabsTrigger value="pt">Professional Tax</TabsTrigger>
      </TabsList>

      <TabsContent value="ctc">
        <Card>
          <CardHeader><CardTitle className="text-base"><AccessAction objectPath="settings/ctc" label="CTC provisions"><span>CTC provisions</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">How an entered CTC splits into pay. Basic is set as a % of CTC; the rest becomes a Special Allowance after employer contributions are added on top. The employer contributions themselves (gratuity, employer PF/ESI, or any you add) are <a href="/pay-components" className="underline">pay components</a> of kind "employer contribution" - configured there, not here.</p>
            <SplitStaleBanner staleCount={staleCount} skippedCount={skippedCount} reapplying={reapplying} canReapply={canReapply} onReapply={doReapply} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Basic % of CTC" hint="Basic = this % of monthly CTC. New wage code wants ≥ 50%."><Input type="number" step="1" value={ctc.basic_pct} onChange={(e) => setCtc((c) => ({ ...c, basic_pct: Number(e.target.value) }))} /></Field>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={ctc.employer_pf_in_ctc} onCheckedChange={(v) => setCtc((c) => ({ ...c, employer_pf_in_ctc: v === true }))} />
              <span>Employer PF is part of CTC<br /><span className="text-xs text-muted-foreground">On (default): the employer PF share counts inside the CTC figure. Off: PF sits over and above CTC ("CTC + PF") - shown as a separate line and excluded from the CTC total, so the split solves the rest of the CTC and PF rides on top.</span></span>
            </label>
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
          <CardHeader><CardTitle className="text-base"><AccessAction objectPath="settings/overtime" label="Overtime policy"><span>Overtime pay</span></AccessAction></CardTitle></CardHeader>
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
          <CardHeader><CardTitle className="text-base"><AccessAction objectPath="settings/professional-tax" label="Professional Tax"><span>Professional Tax slabs</span></AccessAction></CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Monthly slabs by gross wage (state-specific). The last row is the open-ended top bracket (and above).</p>
            <div className="space-y-2">
              {pt.slabs.map((s, i) => {
                const last = i === pt.slabs.length - 1;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Up to</span>
                    {last ? <span className="w-32 text-sm font-medium">and above</span>
                      : <Input type="number" className="w-32" value={s.up_to ?? ""} onChange={(e) => setSlab(i, { up_to: Number(e.target.value) })} />}
                    <span className="text-sm text-muted-foreground">→ deduct</span>
                    <Input type="number" className="w-32" value={s.amount} onChange={(e) => setSlab(i, { amount: Number(e.target.value) })} />
                    {!last && pt.slabs.length > 1 && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setPt((p) => ({ slabs: p.slabs.filter((_, j) => j !== i) }))}><Trash2 className="h-4 w-4" /></Button>}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setPt((p) => ({ slabs: [...p.slabs.slice(0, -1), { up_to: 0, amount: 0 }, p.slabs[p.slabs.length - 1]!] }))}><Plus className="h-4 w-4" /> Add slab</Button>
              <Button size="sm" onClick={savePt}><Save className="h-4 w-4" /> Save</Button>
            </div>
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
    get<{ value?: { award_trigger?: string; default_bonus_amount?: number; join_tiers?: JoinTier[] } }>("settings/referrals")
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
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      // Keep tiers ordered ascending by max_days (nulls last = catch-all), matching the resolver's expectation.
      const clean = [...tiers].sort((a, b) => (a.max_days ?? Infinity) - (b.max_days ?? Infinity));
      await patch("settings/referrals", { value: { award_trigger: trigger, default_bonus_amount: Number(amount) || 0, join_tiers: clean } });
      toast({ title: "Referral settings saved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    } finally { setSaving(false); }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction objectPath="settings/referrals" label="Referral settings"><span>Referral bonuses</span></AccessAction></CardTitle>
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
          {tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
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
    get<{ value?: Partial<AtsConfig> }>("settings/ats")
      .then((s) => { if (s.value && (s.value.stages?.length || s.value.sources?.length)) setCfg({ ...DEFAULT_ATS_CONFIG, ...s.value }); })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const setStage = (i: number, patchStage: Partial<AtsStage>) => setCfg((c) => ({ ...c, stages: c.stages.map((s, j) => (j === i ? { ...s, ...patchStage } : s)) }));
  const addStage = () => setCfg((c) => ({ ...c, stages: [...c.stages, { key: `stage_${c.stages.length + 1}`, label: "New stage", kind: "active" }] }));
  const removeStage = (i: number) => setCfg((c) => ({ ...c, stages: c.stages.filter((_, j) => j !== i) }));
  const moveStage = (i: number, dir: -1 | 1) => setCfg((c) => {
    const j = i + dir; if (j < 0 || j >= c.stages.length) return c;
    const st = [...c.stages]; [st[i], st[j]] = [st[j]!, st[i]!]; return { ...c, stages: st };
  });

  const [saving, setSaving] = useState(false);
  async function save() {
    // Freeze a stable key per stage from its label (keep an existing key so live applications keep their stage).
    const stages = cfg.stages.map((s) => ({ ...s, key: s.key || stageSlug(s.label), label: s.label.trim() || s.key }));
    if (!stages.some((s) => s.kind === "hired")) { toast({ variant: "destructive", title: "Add a Hired stage", description: "One stage must have kind Hired (the success terminal)." }); return; }
    setSaving(true);
    try {
      await patch("settings/ats", { value: { stages, sources: cfg.sources.filter(Boolean), rejection_reasons: cfg.rejection_reasons.filter(Boolean), scorecard_criteria: cfg.scorecard_criteria.filter((c) => c.label.trim()) } });
      toast({ title: "Recruiting settings saved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    } finally { setSaving(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction objectPath="settings/ats" label="Recruiting settings"><span>Recruiting pipeline</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="max-w-2xl space-y-6">
        <Tabs defaultValue="pipeline">
          <TabsList variant="segmented">
            <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
            <TabsTrigger value="sources">Sources & reasons</TabsTrigger>
            <TabsTrigger value="scorecards">Scorecards</TabsTrigger>
          </TabsList>

          <TabsContent value="pipeline" className="space-y-2">
            <p className="text-sm font-medium">Pipeline stages</p>
            <p className="text-xs text-muted-foreground">The ordered columns of the hiring board. Mark exactly one stage as <b>Hired</b> (reaching it marks the candidate hired).</p>
            <div className="space-y-2">
              {cfg.stages.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="flex-1" value={s.label} onChange={(e) => setStage(i, { label: e.target.value })} placeholder="Stage name" />
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

          <TabsContent value="sources" className="space-y-4">
            <Field label="Candidate sources" hint="One per line.">
              <Textarea rows={4} value={cfg.sources.join("\n")} onChange={(e) => setCfg((c) => ({ ...c, sources: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) }))} />
            </Field>
            <Field label="Rejection reasons" hint="One per line.">
              <Textarea rows={4} value={cfg.rejection_reasons.join("\n")} onChange={(e) => setCfg((c) => ({ ...c, rejection_reasons: e.target.value.split("\n").filter((x) => x.trim().length > 0) }))} />
            </Field>
          </TabsContent>

          <TabsContent value="scorecards">
            <Field label="Interview scorecard criteria" hint="One per line. Each becomes a 1-5 rating on interview scorecards.">
              <Textarea rows={4} value={cfg.scorecard_criteria.map((c) => c.label).join("\n")} onChange={(e) => setCfg((c) => ({ ...c, scorecard_criteria: e.target.value.split("\n").filter((x) => x.trim()).map((label) => ({ key: stageSlug(label), label: label.trim() })) }))} />
            </Field>
          </TabsContent>
        </Tabs>

        <Button onClick={save} loading={saving} disabled={!ready}>Save</Button>
      </CardContent>
    </Card>
  );
}

function AttendanceTab({ toast }: { toast: Toast }) {
  const [cfg, setCfg] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    get<{ value?: Partial<AttendanceSchedule> }>("settings/attendance")
      .then((s) => { if (s.value && Object.keys(s.value).length) setCfg({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  const toggleDay = (d: number) =>
    setCfg((c) => ({ ...c, work_days: c.work_days.includes(d) ? c.work_days.filter((x) => x !== d) : [...c.work_days, d].sort((a, b) => a - b) }));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await patch("settings/attendance", { value: cfg });
      toast({ title: "Attendance schedule saved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    } finally { setSaving(false); }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction objectPath="settings/attendance" label="Attendance schedule"><span>Attendance schedule</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="max-w-xl space-y-4">
        <Tabs defaultValue="schedule">
          <TabsList variant="segmented">
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="pay">Pay & proration</TabsTrigger>
          </TabsList>

          <TabsContent value="schedule" className="space-y-4">
            <p className="text-sm text-muted-foreground">Used to flag late arrivals, early departures and absent days. Punch times are recorded as exact instants; the shift below is wall-clock in this timezone.</p>
            <Field label="Timezone" hint="IANA timezone, e.g. Asia/Kolkata.">
              <Input value={cfg.timezone} onChange={(e) => setCfg((c) => ({ ...c, timezone: e.target.value }))} />
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
            <Field label="Grace exceptions" hint="On a listed date lateness/early departure is forgiven for everyone (bad weather, transit strike). Leave extra minutes blank to waive entirely, or add minutes on top of the daily grace.">
              <div className="space-y-2">
                {(cfg.grace_exceptions ?? []).map((ex, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2">
                    <Input type="date" className="w-40" value={ex.date} onChange={(e) => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).map((x, i) => i === idx ? { ...x, date: e.target.value } : x) }))} />
                    <Input className="flex-1 min-w-[10rem]" placeholder="Reason (optional)" value={ex.reason ?? ""} onChange={(e) => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).map((x, i) => i === idx ? { ...x, reason: e.target.value } : x) }))} />
                    <Input type="number" min={0} className="w-32" placeholder="Waive all" value={ex.extra_grace_minutes ?? ""} onChange={(e) => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).map((x, i) => i === idx ? { ...x, extra_grace_minutes: e.target.value === "" ? undefined : Number(e.target.value) } : x) }))} />
                    <Button type="button" variant="ghost" size="icon" onClick={() => setCfg((c) => ({ ...c, grace_exceptions: (c.grace_exceptions ?? []).filter((_, i) => i !== idx) }))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setCfg((c) => ({ ...c, grace_exceptions: [...(c.grace_exceptions ?? []), { date: "" }] }))}><Plus className="h-4 w-4" /> Add date</Button>
              </div>
            </Field>
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
                <div className="mt-3 sm:max-w-xs">
                  <Field label="Per-day rate basis" hint="Divisor for monthly base pay.">
                    <Select value={cfg.lop_basis ?? "working_days"} onValueChange={(v) => setCfg((c) => ({ ...c, lop_basis: v as "working_days" | "days_30" }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="working_days">Working days in the period</SelectItem>
                        <SelectItem value="days_30">Fixed 30 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
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
    get<{ value?: { payout_mode?: string } }>("settings/reimbursements")
      .then((s) => { if (s.value?.payout_mode === "separate") setMode("separate"); })
      .catch(() => {});
  }, []);

  async function save(next: "payroll" | "separate") {
    setMode(next);
    setSaving(true);
    try {
      await patch("settings/reimbursements", { value: { payout_mode: next } });
      toast({ title: "Payout mode saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
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
          <CardContent className="space-y-3 pt-6">
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get<{ value?: { auto_approve_threshold?: number; recurring_default_state?: string; budget_alert_thresholds?: number[] } }>("settings/expenses")
      .then((s) => {
        const v = s.value ?? {};
        if (typeof v.auto_approve_threshold === "number" && v.auto_approve_threshold > 0) setAutoApprove(String(v.auto_approve_threshold));
        if (v.recurring_default_state === "DRAFT") setRecurringState("DRAFT");
        if (Array.isArray(v.budget_alert_thresholds) && v.budget_alert_thresholds.length) setThresholds(v.budget_alert_thresholds.join(", "));
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      const parsedThresholds = thresholds.split(",").map((t) => Number(t.trim())).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      await patch("settings/expenses", {
        value: {
          auto_approve_threshold: Number(autoApprove) > 0 ? Number(autoApprove) : 0,
          recurring_default_state: recurringState,
          budget_alert_thresholds: parsedThresholds.length ? parsedThresholds : [80, 100],
        },
      });
      toast({ title: "Expense settings saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
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
          <CardContent className="space-y-4 pt-6">
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
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");

  useEffect(() => {
    get<{ value?: { categories?: TicketCategory[] } }>("settings/ticket-categories")
      .then((s) => setCats(s.value?.categories ?? []))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const update = (i: number, patch: Partial<TicketCategory>) => setCats((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const add = () => setCats((cs) => [...cs, { key: "", name: "", assignee: null, members: [], department: null }]);
  const remove = (i: number) => setCats((cs) => cs.filter((_, j) => j !== i));
  const empName = (ref: string) => { const e = employees.find((x) => idOf(x.path) === idOf(ref)); return e ? `${e.first_name} ${e.last_name}` : idOf(ref); };
  const addMember = (i: number, ref: string) => setCats((cs) => cs.map((c, j) => (j === i && !(c.members ?? []).includes(ref) ? { ...c, members: [...(c.members ?? []), ref] } : c)));
  const removeMember = (i: number, ref: string) => setCats((cs) => cs.map((c, j) => (j === i ? { ...c, members: (c.members ?? []).filter((m) => m !== ref) } : c)));

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
      await patch("settings/ticket-categories", { value: { categories: out } });
      setCats(out);
      toast({ title: "Ticket categories saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction objectPath="settings/ticket-categories" label="Ticket categories"><span>Ticket categories</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Each category routes new tickets to a default assignee and servicing department (changeable per ticket). Members and the department's managers see every ticket in the category.</p>
        <div className="space-y-2">
          {cats.map((c, i) => (
            <div key={i} className="space-y-3 rounded-lg border p-3">
              <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-3">
                <Field label="Category">
                  <Input value={c.name} placeholder="e.g. IT support" onChange={(e) => update(i, { name: e.target.value })} />
                </Field>
                <Field label="Auto-assign to">
                  <Select value={c.assignee ?? "none"} onValueChange={(v) => update(i, { assignee: v === "none" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {employees.map((e) => <SelectItem key={e.path} value={`employees/${idOf(e.path)}`}>{e.first_name} {e.last_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Servicing department">
                  <Select value={c.department ?? "none"} onValueChange={(v) => update(i, { department: v === "none" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove"><Trash2 className="h-4 w-4" /></Button>
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
  const original = (checklist.items ?? []).join("\n");
  const [name, setName] = useState(checklist.display_name);
  const [items, setItems] = useState(original);
  const [busy, setBusy] = useState(false);
  const dirty = name !== checklist.display_name || items !== original;

  async function save() {
    setBusy(true);
    try {
      await patch(checklist.path, { display_name: name.trim(), items: items.split("\n").map((s) => s.trim()).filter(Boolean) }, checklist.etag);
      reload();
      toast({ title: "Checklist saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  async function del() {
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

// Organization identity (name + logo) - a single settings/organization row; the logo is a small data URL.
// Saving refreshes the app-wide org context so the sidebar brand updates immediately.
// The organization blob (settings/organization) backs three panels: identity, banks & currency and letter
// defaults. Each panel loads the full blob, edits its slice, and saves slice-merged-into-blob so the other
// panels' fields survive (read-modify-write; single-admin last-write-wins is fine here).
function useOrgBlob(toast: Toast) {
  const { reload } = useOrg();
  const [blob, setBlob] = useState<Partial<OrgSettings> | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    get<{ value?: Partial<OrgSettings> }>("settings/organization")
      .then((s) => setBlob(s.value ?? {}))
      .catch(() => setBlob({}));
  }, []);
  async function save(slice: Record<string, unknown>, savedTitle: string) {
    setSaving(true);
    try {
      const value = { ...(blob ?? {}), ...slice };
      await patch("settings/organization", { value });
      setBlob(value as Partial<OrgSettings>);
      reload();
      toast({ title: savedTitle, variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
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
  const hydrated = useRef(false);

  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
    // Drop unknown ids up front so the editor only ever shows real actions.
    const known = new Set(CONFIGURABLE_QUICK_ACTIONS.map((a) => a.id));
    setGroups(
      normalizeQuickMenu(blob.quick_actions).groups.map((g) => ({ ...g, items: g.items.filter((id) => known.has(id)) })),
    );
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

  async function onSave() {
    const cleaned = groups.map((g) => ({ id: g.id, label: g.label.trim() || "Untitled", items: g.items }));
    await save({ quick_actions: { groups: cleaned, order: undefined } }, "Quick create menu saved");
  }

  if (!blob) return panelLoading;

  const groupOptions = groups.map((g) => ({ value: g.id, label: g.label.trim() || "Untitled" }));

  const actionRow = (id: string, opts: { gid?: string; index?: number; count?: number }) => {
    const a = metaOf(id);
    if (!a) return null;
    const Icon = a.icon;
    const inGroup = !!opts.gid;
    return (
      <div key={id} className="flex items-center gap-3 rounded-md border px-3 py-2">
        <Icon className={cn("h-4 w-4 shrink-0", inGroup ? "text-foreground" : "text-muted-foreground")} />
        <span className={cn("flex-1 truncate text-sm", !inGroup && "text-muted-foreground")}>{a.label}</span>
        <Select value={opts.gid ?? "off"} onValueChange={(v) => assign(id, v)}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
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

function OrgIdentityPanel({ toast }: { toast: Toast }) {
  const { blob, save, saving } = useOrgBlob(toast);
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [logo, setLogo] = useState<string | undefined>(undefined);
  const [logoText, setLogoText] = useState(""); // sidebar wordmark override (casing/spelling); blank = use name
  const [nameFont, setNameFont] = useState("default");
  const [nameWeight, setNameWeight] = useState("bold");
  const [nameSize, setNameSize] = useState("medium");
  const [address, setAddress] = useState("");
  const [incorporationDate, setIncorporationDate] = useState("");
  const [defaultDept, setDefaultDept] = useState("none"); // org-wide default department for cards + tickets
  const [primaryColor, setPrimaryColor] = useState("#1A2980"); // brand accent (email header/buttons; hex)
  const [emailLogoUrl, setEmailLogoUrl] = useState(""); // public https logo for email headers (the app logo is a data URL, which email clients strip)
  const { rows: departments } = useCollection<Department>("departments");

  const hydrated = useRef(false);
  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
    if (blob.name) setName(blob.name);
    if (blob.legal_name) setLegalName(blob.legal_name);
    if (blob.logo) setLogo(blob.logo);
    if (blob.logo_text) setLogoText(blob.logo_text);
    if (blob.name_font) setNameFont(blob.name_font);
    if (blob.name_weight) setNameWeight(blob.name_weight);
    if (blob.name_size) setNameSize(blob.name_size);
    if (blob.address) setAddress(blob.address);
    if (blob.incorporation_date) setIncorporationDate(blob.incorporation_date);
    if (blob.default_department) setDefaultDept(blob.default_department);
    if (blob.primary_color) setPrimaryColor(blob.primary_color);
    if (blob.email_logo_url) setEmailLogoUrl(blob.email_logo_url);
  }, [blob]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_LOGO_BYTES) {
      toast({ variant: "destructive", title: "Logo too large", description: "Use an image under 256 KB." });
      return;
    }
    const r = new FileReader();
    r.onload = () => setLogo(r.result as string);
    r.readAsDataURL(f);
  }

  async function saveIdentity() {
    await save(
      { name: name.trim(), legal_name: legalName.trim() || null, logo: logo ?? null, logo_text: logoText.trim() || null, name_font: nameFont, name_weight: nameWeight, name_size: nameSize, address: address.trim() || null, incorporation_date: incorporationDate || null, default_department: defaultDept === "none" ? null : defaultDept, primary_color: primaryColor || null, email_logo_url: emailLogoUrl.trim() || null },
      "Organization saved",
    );
  }

  return (
    <div>
      {/* Identity: logo avatar + name on one centered row. */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                {logo ? <img src={logo} alt="" className="h-full w-full object-cover" /> : <Building className="h-6 w-6 text-muted-foreground" />}
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
                    {logo ? "Replace" : "Choose logo"}
                    <input type="file" accept="image/*" className="hidden" onChange={onFile} />
                  </label>
                  {logo && (
                    <Button variant="ghost" size="sm" onClick={() => setLogo(undefined)}>
                      <X className="h-4 w-4" /> Remove
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">PNG or JPG, under 256 KB.</p>
              </div>
            </div>
            <div className="flex-1 space-y-6">
              <Field label="Legal name" hint="Registered legal entity name. Leave blank to use the organization name.">
                <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="e.g. Acme Technologies Private Limited" />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Organization name" hint="Shown across the app and on payslips.">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Corp" />
                </Field>
                <Field label="Sidebar display name" hint="Logo wordmark only (casing/spelling). Blank uses the organization name.">
                  <Input value={logoText} onChange={(e) => setLogoText(e.target.value)} placeholder={name || "e.g. acme"} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-start">
                <Field label="Font">
                  <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={nameFont} onChange={(e) => setNameFont(e.target.value)}>
                    {NAME_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </Field>
                <Field label="Weight">
                  <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={nameWeight} onChange={(e) => setNameWeight(e.target.value)}>
                    {NAME_WEIGHTS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </Field>
                <Field label="Size">
                  <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={nameSize} onChange={(e) => setNameSize(e.target.value)}>
                    {NAME_SIZES.map((sz) => <option key={sz.value} value={sz.value}>{sz.label}</option>)}
                  </select>
                </Field>
                <Field label="Preview" hint="Styles the sidebar logo only.">
                  <div className="flex h-9 items-center rounded-md bg-sidebar px-3">
                    <span className="truncate text-white" style={{ fontFamily: orgNameFontStack(nameFont), fontWeight: orgNameWeight(nameWeight), fontSize: orgNameSizePx(nameSize) }}>{logoText.trim() || name || "Acme Corp"}</span>
                  </div>
                </Field>
              </div>
              <Field label="Address" hint="Printed in the payslip header. One line per row.">
                <Textarea rows={3} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={"Street address\nArea or landmark\nCity, State PIN"} />
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Brand colour" hint="Accent for email headers and buttons.">
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Brand colour" value={/^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : "#1A2980"} onChange={(e) => setPrimaryColor(e.target.value)} className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1" />
                    <Input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} placeholder="#1A2980" className="font-mono" />
                  </div>
                </Field>
                <Field label="Email logo URL" hint="Public https image shown in email headers. The uploaded logo above is embedded (data URL) which email clients block, so email uses this URL instead; blank shows the name.">
                  <Input value={emailLogoUrl} onChange={(e) => setEmailLogoUrl(e.target.value)} placeholder="https://cdn.example.com/logo.png" />
                </Field>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
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

  const hydrated = useRef(false);
  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
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

  async function saveBanks() {
    const allowed = allowedList.length ? allowedList : ["INR"];
    const def = allowed.includes(defaultCurrency) ? defaultCurrency : allowed[0];
    // Persist a decimals entry for every allowed currency (resolved value), so the config is explicit.
    const currency_decimals = Object.fromEntries(allowed.map((c) => [c, dpFor(c)]));
    await save({ currencies: allowed, default_currency: def, currency_decimals, banks: bankList }, "Banks & currency saved");
  }

  return (
    <div>
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-4">
              <Field label="Allowed currencies" hint="Comma-separated ISO codes.">
                <Input value={currencies} onChange={(e) => setCurrencies(e.target.value)} placeholder="INR, USD, EUR" />
              </Field>
              <Field label="Default currency" hint="Default selection, and used for untagged amounts.">
                <select
                  className="h-9 w-40 rounded-md border bg-background px-2 text-sm"
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

  const hydrated = useRef(false);
  useEffect(() => {
    if (!blob || hydrated.current) return;
    hydrated.current = true;
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

  async function saveLetterDefaults() {
    // Drop blank fields so the stored block stays tidy; coerce validity to a number.
    const letterDefaults: LetterDefaults = {};
    for (const [k, v] of Object.entries(letter)) {
      if (k === "offer_validity_days") { const n = Number(v); if (Number.isFinite(n) && n > 0) letterDefaults.offer_validity_days = n; }
      else if (typeof v === "string" && v.trim()) (letterDefaults as Record<string, unknown>)[k] = v.trim();
    }
    if (signatorySig) letterDefaults.signatory_signature = signatorySig; // employer e-signature (omitted when cleared)
    if (companyStamp) letterDefaults.company_stamp = companyStamp; // company stamp/seal (omitted when cleared)
    await save({ letter_defaults: letterDefaults }, "Letter defaults saved");
  }

  return (
    <div>
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-4">
              <Field label="Signatory name" hint="Signs generated letters.">
                <Input value={letter.signatory_name ?? ""} onChange={(e) => setLetterField("signatory_name", e.target.value)} placeholder="Full name of the signatory" />
              </Field>
              <Field label="Signatory title">
                <Input value={letter.signatory_title ?? ""} onChange={(e) => setLetterField("signatory_title", e.target.value)} placeholder="e.g. HR Manager" />
              </Field>
              <Field label="Signatory signature" hint="The employer's e-signature, stamped above the signatory name on generated letters.">
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-40 items-center justify-center overflow-hidden rounded-md border bg-white p-1 dark:bg-zinc-100">
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
                  <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-white p-1 dark:bg-zinc-100">
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
              <Field label="HR contact name">
                <Input value={letter.hr_name ?? ""} onChange={(e) => setLetterField("hr_name", e.target.value)} placeholder="e.g. HR Department" />
              </Field>
              <Field label="HR contact email" hint="Falls back to the system sender if blank.">
                <Input value={letter.hr_email ?? ""} onChange={(e) => setLetterField("hr_email", e.target.value)} placeholder="hr@example.com" />
              </Field>
              <Field label="HR contact phone">
                <Input value={letter.hr_phone ?? ""} onChange={(e) => setLetterField("hr_phone", e.target.value)} placeholder="Optional" />
              </Field>
            </div>
            <div className="space-y-4">
              <Field label="Working hours" hint="Shown in the offer letter.">
                <Input value={letter.working_hours ?? ""} onChange={(e) => setLetterField("working_hours", e.target.value)} placeholder="e.g. 10:00 AM to 7:00 PM" />
              </Field>
              <Field label="Working days">
                <Input value={letter.working_days ?? ""} onChange={(e) => setLetterField("working_days", e.target.value)} placeholder="e.g. Monday to Friday" />
              </Field>
              <Field label="Work mode">
                <select
                  className="h-9 w-40 rounded-md border bg-background px-2 text-sm"
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
            </div>
          </div>
        </CardContent>
      </Card>
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
  const { rows: employees } = useCollection<Employee>("employees");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  // Which KPI category bands are expanded in this editor (all collapsed by default so the list stays short).
  const [openCats, setOpenCats] = useState<Set<KpiCategory>>(new Set());
  const toggleCat = (cat: KpiCategory) => setOpenCats((s) => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
  useEffect(() => {
    get<{ value?: DashboardConfig }>("settings/dashboard").then((s) => setCfg(s.value ?? {})).catch(() => {}).finally(() => setReady(true));
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
  async function save(savedMsg: string) {
    setSaving(true);
    try {
      await patch("settings/dashboard", { value: cfg });
      toast({ title: savedMsg, variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }
  const section = (defs: { key: string; label: string }[], sec: DashSection, saveLabel: string, savedMsg: string, emptyLabel: string) => (
    <div className="space-y-2">
      <div className="divide-y rounded-lg border">
        {defs.map((d) => (
          <div key={d.key} className="flex items-center gap-3 px-3 py-2">
            <span className="w-48 shrink-0 text-sm font-medium">{d.label}</span>
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
                    <div key={d.key} className="flex items-center gap-3 px-3 py-2">
                      <span className="flex w-48 shrink-0 items-center gap-2 text-sm font-medium">
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
  return (
    <Card>
      <CardHeader>
        <CardTitle><AccessAction collection="settings" objectPath="settings/dashboard" label="Dashboard"><span>Dashboard</span></AccessAction></CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Choose who sees each KPI card and timeline marker: Everyone, specific roles, or specific people. Selecting no one hides the item. KPI cards group into categories (Needs attention / Coming up / At a glance) - untick a category to hide the whole band. Out of the box, broadly useful cards show to everyone, HR-related cards to HR admins, and the rest stay hidden until you share them; timeline markers default to everyone. Leaves, holidays and weekends always show on the timeline.</p>
        <Tabs defaultValue="kpis">
          <TabsList variant="segmented">
            <TabsTrigger value="kpis">KPI cards</TabsTrigger>
            <TabsTrigger value="timeline">Timeline markers</TabsTrigger>
          </TabsList>
          <TabsContent value="kpis">{kpiSection()}</TabsContent>
          <TabsContent value="timeline">{section(MARKER_DEFS, "timeline", "Save markers", "Timeline markers saved", "Everyone")}</TabsContent>
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
          <Input className="mb-1.5 h-8" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get<{ value?: { default_months?: number } }>("settings/probation")
      .then((s) => typeof s.value?.default_months === "number" && setProbation(String(s.value.default_months)))
      .catch(() => {});
    get<{ value?: { max_optional?: number } }>("settings/holidays")
      .then((s) => typeof s.value?.max_optional === "number" && setMaxOptional(String(s.value.max_optional)))
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      await patch("settings/probation", { value: { default_months: Number(probation) } });
      await patch("settings/holidays", { value: { max_optional: Number(maxOptional) } });
      toast({ title: "Policies saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default probation period (months)" hint="Used to default an employee's probation end from their start date.">
            <Input type="number" min={0} value={probation} onChange={(e) => setProbation(e.target.value)} />
          </Field>
          <Field label="Max optional holidays per employee" hint="How many optional holidays each employee may pick.">
            <Input type="number" min={0} value={maxOptional} onChange={(e) => setMaxOptional(e.target.value)} />
          </Field>
        </div>
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
function formatNum(c: NumCfg, seq: number): string {
  const parts: string[] = [];
  if (c.prefix) parts.push(c.prefix);
  if (c.include_year) parts.push(c.year_format === "YY" ? String(new Date().getFullYear()).slice(-2) : String(new Date().getFullYear()));
  parts.push(String(Math.max(0, seq)).padStart(Math.max(1, Math.min(12, c.width)), "0"));
  return parts.join(c.separator ?? "");
}
function EmployeeIdsTab({ toast }: { toast: Toast }) {
  const [cfg, setCfg] = useState<NumCfg>(DEFAULT_NUM_CFG);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<NumCfg>) => setCfg((c) => ({ ...c, ...p }));

  useEffect(() => {
    get<{ value?: Partial<NumCfg> }>("settings/employee-number")
      .then((s) => s.value && setCfg({ ...DEFAULT_NUM_CFG, ...s.value }))
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      await patch("settings/employee-number", { value: { ...cfg, width: Number(cfg.width), start: Number(cfg.start) } });
      toast({ title: "Employee ID format saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
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
                <SelectItem value="YYYY">{String(new Date().getFullYear())} (YYYY)</SelectItem>
                <SelectItem value="YY">{String(new Date().getFullYear()).slice(-2)} (YY)</SelectItem>
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get<{ value?: Record<string, unknown> }>("settings/leave_caps")
      .then((s) => {
        const v = s.value ?? {};
        if (v.carry_forward_excess === "forfeit") setExcess("forfeit");
        if (v.carry_forward_mode === "cumulative") setCfMode("cumulative");
        if (typeof v.carry_forward_cumulative_cap_days === "number") setCfCap(String(v.carry_forward_cumulative_cap_days));
        if (v.encashment_mode === "cumulative") setEncMode("cumulative");
        if (typeof v.encashment_cumulative_cap_days === "number") setEncCap(String(v.encashment_cumulative_cap_days));
      })
      .catch(() => {});
    get<{ value?: { rate_basis?: string; per_day_divisor?: number } }>("settings/leave_encashment")
      .then((s) => { if (s.value?.rate_basis === "gross") setEncRateBasis("gross"); if (typeof s.value?.per_day_divisor === "number") setEncDivisor(String(s.value.per_day_divisor)); })
      .catch(() => {});
    get<{ value?: { rounding?: string } }>("settings/leave_accrual")
      .then((s) => { const r = s.value?.rounding; if (r === "none" || r === "half" || r === "day") setRounding(r); })
      .catch(() => {});
    get<{ value?: { allow_backdated?: boolean } }>("settings/leave-requests")
      .then((s) => { if (typeof s.value?.allow_backdated === "boolean") setAllowBackdated(s.value.allow_backdated); })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      await patch("settings/leave_caps", {
        value: {
          carry_forward_excess: excess,
          carry_forward_mode: cfMode,
          carry_forward_cumulative_cap_days: cfCap.trim() === "" ? null : Number(cfCap),
          encashment_mode: encMode,
          encashment_cumulative_cap_days: encCap.trim() === "" ? null : Number(encCap),
        },
      });
      await patch("settings/leave_encashment", { value: { rate_basis: encRateBasis, per_day_divisor: encDivisor.trim() === "" ? 30 : Number(encDivisor) } });
      await patch("settings/leave_accrual", { value: { rounding } });
      await patch("settings/leave-requests", { value: { allow_backdated: allowBackdated } });
      toast({ title: "Leave policy saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base"><AccessAction objectPath="settings/leave_caps" label="Leave policy"><span>Policy</span></AccessAction></CardTitle></CardHeader>
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

  useEffect(() => {
    get<{ value?: { fields?: EmployeeFieldDef[] } }>("settings/employee_fields")
      .then((s) => setFields(s.value?.fields?.length ? s.value.fields : DEFAULT_FIELDS))
      .catch(() => setFields(DEFAULT_FIELDS))
      .finally(() => setLoaded(true));
  }, []);

  const update = (i: number, patch: Partial<EmployeeFieldDef>) =>
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => setFields((fs) => fs.filter((_, idx) => idx !== i));
  const add = () => setFields((fs) => [...fs, { key: "", label: "", mandatory: false, sensitive: false, document: "none" }]);

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
      await patch("settings/employee_fields", { value: { fields: cleaned } });
      setFields(cleaned);
      toast({ title: "Employee fields saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base"><AccessAction objectPath="settings/employee_fields" label="Employee fields"><span>Employee identity fields</span></AccessAction></CardTitle>
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
                <div key={i} className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-3 p-2">
                  <Input value={f.label} placeholder="e.g. Passport number" onChange={(e) => update(i, { label: e.target.value })} />
                  <div className="flex w-20 justify-center">
                    <Checkbox checked={f.mandatory} onCheckedChange={(v) => update(i, { mandatory: v === true })} />
                  </div>
                  <div className="flex w-20 justify-center">
                    <Checkbox checked={f.sensitive} onCheckedChange={(v) => update(i, { sensitive: v === true })} />
                  </div>
                  <select
                    className="h-9 w-28 rounded-md border bg-background px-2 text-sm"
                    value={f.document ?? "none"}
                    onChange={(e) => update(i, { document: e.target.value as EmployeeFieldDef["document"] })}
                  >
                    <option value="none">No document</option>
                    <option value="allowed">Allowed</option>
                    <option value="required">Required</option>
                  </select>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(i)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {fields.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">No fields. Add one below.</p>}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={add}><Plus className="h-4 w-4" /> Add field</Button>
          <Button onClick={save} loading={saving}>{!saving && <Save className="h-4 w-4" />} Save fields</Button>
          <Badge variant="muted" className="ml-auto">Applies to all employees</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
